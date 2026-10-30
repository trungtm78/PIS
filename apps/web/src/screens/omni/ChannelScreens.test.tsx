import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Link } from 'react-router-dom';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { harness, mount, routeOf } from '../not/delivery/test-support';
import ChannelConfigScreen from './ChannelConfigScreen';
import ChannelConnectScreen from './ChannelConnectScreen';
import {
  canDisable,
  canEdit,
  canVerify,
  connectBody,
  describeProblem,
  emptyConnectForm,
  formProblems,
  isReasonValid,
  isWaiting,
  toAccount,
  toAccountPage,
} from './channel/model';

const SUPERVISOR = ['omni.channel.manage', 'channel_account.read'];
const READER = ['channel_account.read'];
const NOBODY = ['delivery_attempt.read'];
const reason = 'Checked with the owner of the account.';
const problem = (code: string, status = 409, detail?: string) => new ApiError({ status, code, correlationId: 'c', detail });

const accountRow = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `account-${n}`,
  channel: 'WHATSAPP',
  external_account_id: `1048576000${n}`,
  display_name: `Hotline ${n}`,
  status: 'Active',
  credential_configured: true,
  webhook_configured: true,
  verified_at: '2026-10-30T02:00:00Z',
  verify_requested_at: null,
  verification_error: null,
  auto_reply_text: null,
  calendar_code: null,
  daily_send_cap: null,
  monthly_budget_vnd: null,
  created_at: '2026-10-29T02:00:00Z',
  version: 3,
  ...overrides,
});

afterEach(cleanup);

interface World {
  accounts?: Array<Record<string, unknown>> | Error;
}

function open(element: JSX.Element, permissions: readonly string[], world: World = {}, command: (operation: string, input: unknown) => unknown = () => ({}), entry = '/') {
  const h = harness((operation, input) => {
    switch (operation) {
      case 'get_resources_channel_account':
        return world.accounts instanceof Error ? world.accounts : { items: world.accounts ?? [], next_cursor: null };
      case 'get_resources_channel_account_id': {
        if (world.accounts instanceof Error) return world.accounts;
        const found = (world.accounts ?? []).find((row) => row.id === (input as { path: { id: string } }).path.id);
        return found ?? new ApiError({ status: 404, code: 'RESOURCE_NOT_FOUND', correlationId: 'c' });
      }
      default:
        return new Error(`unexpected read ${operation}`);
    }
  }, command);
  return { h, ...mount(element, h, { permissions, entry }) };
}

const connectScreen = (permissions: readonly string[], world: World, command?: (operation: string, input: unknown) => unknown) =>
  open(<ChannelConnectScreen route={routeOf('OMNI-05', 'FR-OMNI-05')} />, permissions, world, command);
const configScreen = (permissions: readonly string[], world: World, command?: (operation: string, input: unknown) => unknown, entry = '/omni/omni-06?id=account-1') =>
  open(<ChannelConfigScreen route={routeOf('OMNI-06', 'FR-OMNI-06')} />, permissions, world, command, entry);

describe('OMNI-05 the channel connections (UI-OMNI-05)', () => {
  it('AC-ST-OMNI-001-2 UI-OMNI-05: shows a card for each account with its status and the secrets only as "configured", never a reference to one', async () => {
    connectScreen(SUPERVISOR, { accounts: [accountRow(1), accountRow(2, { channel: 'PUSH_FCM', webhook_configured: false, status: 'PendingVerification', verified_at: null })] });
    const cards = await screen.findAllByRole('article');
    expect(cards).toHaveLength(2);
    const first = document.querySelector('[data-account-id="account-1"]') as HTMLElement;
    expect(within(first).getByText(vi_['omni.channel.status.active'])).toBeTruthy();
    expect(first.querySelector('[data-secrets]')?.textContent).toContain(vi_['omni.channel.secret.configured']);
    const push = document.querySelector('[data-account-id="account-2"]') as HTMLElement;
    expect(push.getAttribute('data-status')).toBe('PendingVerification');
    expect(push.querySelector('[data-verified-at]')?.textContent).toContain(vi_['omni.channel.card.neverVerified']);
    expect(push.querySelector('[data-secrets]')?.textContent).toContain(vi_['omni.channel.secret.notNeeded']);
    expect((document.querySelector('[data-accounts]') as HTMLElement).textContent).not.toContain('secret://');
    expect(within(first).getByRole('link', { name: vi_['omni.channel.card.open.action'] }).getAttribute('href')).toBe('/omni/omni-06?id=account-1');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['omni.channel.page.title']);
  });

  it('AC-ST-OMNI-001-2 UI-OMNI-05: shows a loading state, then the denied, signed-out, offline and error states, and says in words when there is no account', async () => {
    for (const [error, title] of [
      [new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }), vi_['states.denied.title']],
      [new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' }), vi_['states.signedOut.title']],
      [new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), vi_['states.offline.title']],
      [new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' }), vi_['states.error.title']],
    ] as const) {
      connectScreen(SUPERVISOR, { accounts: error });
      expect(await screen.findByText(title)).toBeTruthy();
      cleanup();
    }
    const loading = connectScreen(SUPERVISOR, { accounts: [] });
    expect(loading.container.querySelector('[role="status"]')).not.toBeNull();
    expect(await screen.findByText(vi_['omni.channel.list.none'])).toBeTruthy();
    cleanup();
    const { h } = connectScreen(NOBODY, { accounts: [] });
    expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
    expect(h.read).not.toHaveBeenCalled();
  });

  it('asks for the accounts of the status and the channel chosen', async () => {
    const { h } = connectScreen(SUPERVISOR, { accounts: [accountRow(1)] });
    await screen.findAllByRole('article');
    fireEvent.change(screen.getByLabelText(vi_['omni.channel.filter.status.label']), { target: { value: 'Disabled' } });
    fireEvent.change(screen.getByLabelText(vi_['omni.channel.filter.channel.label']), { target: { value: 'SMS' } });
    await waitFor(() => expect(h.read).toHaveBeenLastCalledWith('get_resources_channel_account', { query: { status: 'Disabled', channel: 'SMS' } }));
  });

  it('connects an account with references to its secrets, tells a pasted secret before sending, and starts the form over after it was saved', async () => {
    const { h } = connectScreen(SUPERVISOR, { accounts: [] }, () => ({ operation_id: 'o', status: 'PENDING_VERIFICATION', resource_version: 1, resource_id: 'account-9' }));
    await screen.findByText(vi_['omni.channel.list.none']);
    fireEvent.change(screen.getByLabelText(vi_['omni.channel.form.channel.label']), { target: { value: 'WHATSAPP' } });
    fireEvent.change(screen.getByLabelText(vi_['omni.channel.form.externalId.label']), { target: { value: '104857600123' } });
    fireEvent.change(screen.getByLabelText(vi_['omni.channel.form.displayName.label']), { target: { value: 'Hotline' } });
    // A token written where its reference belongs is refused here, and nothing is sent.
    fireEvent.change(screen.getByLabelText(vi_['omni.channel.form.credential.label']), { target: { value: 'EAAG-pasted-token' } });
    fireEvent.change(screen.getByLabelText(vi_['omni.channel.form.webhook.label']), { target: { value: 'secret://omni/wa/webhook' } });
    fireEvent.click(screen.getByRole('button', { name: vi_['omni.channel.form.submit.action'] }));
    expect((await screen.findAllByRole('alert')).map((node) => node.textContent)).toContain(vi_['omni.channel.form.credentialSecretRef.invalid']);
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(vi_['omni.channel.form.credential.label']), { target: { value: 'secret://omni/wa/token' } });
    fireEvent.click(screen.getByRole('button', { name: vi_['omni.channel.form.submit.action'] }));
    expect(await screen.findByText(vi_['omni.channel.done.connected'])).toBeTruthy();
    expect(h.command).toHaveBeenCalledWith(
      'connectChannelAccount',
      expect.objectContaining({ body: { channel: 'WHATSAPP', external_account_id: '104857600123', display_name: 'Hotline', credential_secret_ref: 'secret://omni/wa/token', webhook_secret_ref: 'secret://omni/wa/webhook' } }),
    );
    expect((screen.getByLabelText(vi_['omni.channel.form.externalId.label']) as HTMLInputElement).value).toBe('');
  });

  it('asks for no webhook secret on a push channel, and says in words what the server refused with', async () => {
    connectScreen(SUPERVISOR, { accounts: [] }, () => problem('CHANNEL_ACCOUNT_EXISTS', 409));
    await screen.findByText(vi_['omni.channel.list.none']);
    fireEvent.change(screen.getByLabelText(vi_['omni.channel.form.channel.label']), { target: { value: 'PUSH_FCM' } });
    expect(screen.queryByLabelText(vi_['omni.channel.form.webhook.label'])).toBeNull();
    expect(document.querySelector('[data-no-webhook]')).not.toBeNull();
    fireEvent.change(screen.getByLabelText(vi_['omni.channel.form.externalId.label']), { target: { value: 'fcm-project' } });
    fireEvent.change(screen.getByLabelText(vi_['omni.channel.form.displayName.label']), { target: { value: 'FCM' } });
    fireEvent.change(screen.getByLabelText(vi_['omni.channel.form.credential.label']), { target: { value: 'secret://omni/fcm/key' } });
    fireEvent.click(screen.getByRole('button', { name: vi_['omni.channel.form.submit.action'] }));
    expect(await screen.findByText(vi_['omni.channel.problem.exists'])).toBeTruthy();
  });

  it('offers no form to a reader, nor to a tenant that is read only', async () => {
    connectScreen(READER, { accounts: [accountRow(1)] });
    await screen.findAllByRole('article');
    expect(screen.queryByRole('form', { name: vi_['omni.channel.form.aria'] })).toBeNull();
    cleanup();
    const h = harness(() => ({ items: [accountRow(1)], next_cursor: null }));
    mount(<ChannelConnectScreen route={routeOf('OMNI-05', 'FR-OMNI-05')} />, h, { permissions: SUPERVISOR, mode: 'READ_ONLY' });
    await screen.findAllByRole('article');
    expect(screen.queryByRole('form', { name: vi_['omni.channel.form.aria'] })).toBeNull();
  });
});

describe('OMNI-06 the channel settings (UI-OMNI-06)', () => {
  it('AC-ST-OMNI-001-4 UI-OMNI-06: shows the facts of an account with the secrets as "configured", the state of a closed account and no way to change it', async () => {
    configScreen(SUPERVISOR, { accounts: [accountRow(1, { status: 'Disabled' })] });
    expect(await screen.findByText(vi_['omni.config.disabled.note'])).toBeTruthy();
    const facts = document.querySelector('[data-account-facts]') as HTMLElement;
    expect(facts.getAttribute('data-status')).toBe('Disabled');
    expect(facts.querySelector('[data-credential]')?.textContent).toBe(vi_['omni.channel.secret.configured']);
    expect(facts.querySelector('[data-webhook]')?.textContent).toBe(vi_['omni.channel.secret.configured']);
    expect(document.body.textContent).not.toContain('secret://');
    expect(document.querySelector('[data-channel-disabled]')).not.toBeNull();
    expect(screen.queryByRole('button', { name: vi_['omni.config.disable.action'] })).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['omni.config.verify.action'] })).toBeNull();
    expect(document.querySelector('[data-edit]')).toBeNull();
  });

  it('AC-ST-OMNI-001-4 UI-OMNI-06: shows a loading state, then the denied, signed-out, offline and error states, and says in words when the account is not found or not chosen', async () => {
    for (const [error, title] of [
      [new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }), vi_['states.denied.title']],
      [new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' }), vi_['states.signedOut.title']],
      [new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), vi_['states.offline.title']],
      [new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' }), vi_['states.error.title']],
    ] as const) {
      configScreen(SUPERVISOR, { accounts: error });
      expect(await screen.findByText(title)).toBeTruthy();
      cleanup();
    }
    const loading = configScreen(SUPERVISOR, { accounts: [accountRow(1)] });
    expect(loading.container.querySelector('[role="status"]')).not.toBeNull();
    expect(await screen.findByText(accountRow(1).display_name)).toBeTruthy();
    cleanup();
    configScreen(SUPERVISOR, { accounts: [accountRow(1)] }, undefined, '/omni/omni-06?id=account-404');
    expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
    cleanup();
    configScreen(SUPERVISOR, { accounts: [accountRow(1)] }, undefined, '/omni/omni-06');
    expect(await screen.findByText(vi_['omni.config.noSelection'])).toBeTruthy();
    cleanup();
    const { h } = configScreen(NOBODY, { accounts: [accountRow(1)] });
    expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
    expect(h.read).not.toHaveBeenCalled();
  });

  it('asks for a verification of a pending account with a reason, at the version read, and says that it waits for the provider', async () => {
    const { h } = configScreen(SUPERVISOR, { accounts: [accountRow(1, { status: 'PendingVerification', verified_at: null, version: 1, verification_error: 'CREDENTIAL_INVALID' })] }, () => ({ operation_id: 'o', status: 'VERIFICATION_REQUESTED', resource_version: 2, resource_id: 'account-1' }));
    expect(await screen.findByText(vi_['omni.config.error.note'].replace('{reason}', vi_['omni.config.error.credentialInvalid']))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: vi_['omni.config.verify.action'] }));
    const panel = await screen.findByTestId('channel-verify');
    fireEvent.change(within(panel).getByLabelText(vi_['omni.config.reason.label']), { target: { value: reason } });
    fireEvent.click(within(panel).getByRole('button', { name: vi_['omni.config.confirm.action'] }));
    expect(await screen.findByText(vi_['omni.config.done.verify'])).toBeTruthy();
    expect(h.command).toHaveBeenCalledWith('verifyChannelAccount', expect.objectContaining({ path: { channelAccountId: 'account-1' }, body: { reason }, ifMatchVersion: 1 }));
  });

  it('shows a verification that waits for the provider and offers no second one', async () => {
    configScreen(SUPERVISOR, { accounts: [accountRow(1, { status: 'PendingVerification', verified_at: null, verify_requested_at: new Date().toISOString() })] });
    expect(await screen.findByText(vi_['omni.config.waiting.note'])).toBeTruthy();
    expect(screen.queryByRole('button', { name: vi_['omni.config.verify.action'] })).toBeNull();
  });

  it('offers the verification again when the request has waited so long that it is stranded', async () => {
    const { h } = configScreen(SUPERVISOR, { accounts: [accountRow(1, { status: 'PendingVerification', verified_at: null, version: 2, verify_requested_at: new Date(Date.now() - 5 * 60_000).toISOString() })] }, () => ({ operation_id: 'o', status: 'VERIFICATION_REQUESTED', resource_version: 3, resource_id: 'account-1' }));
    expect(await screen.findByText(vi_['omni.config.waiting.note'])).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: vi_['omni.config.verify.action'] }));
    const panel = await screen.findByTestId('channel-verify');
    fireEvent.change(within(panel).getByLabelText(vi_['omni.config.reason.label']), { target: { value: reason } });
    fireEvent.click(within(panel).getByRole('button', { name: vi_['omni.config.confirm.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('verifyChannelAccount', expect.objectContaining({ ifMatchVersion: 2 })));
  });

  it('offers the verification again by itself once a request has waited a minute, without a reload', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    try {
      vi.setSystemTime(new Date('2026-10-30T10:00:00Z'));
      configScreen(SUPERVISOR, { accounts: [accountRow(1, { status: 'PendingVerification', verified_at: null, verify_requested_at: '2026-10-30T09:59:30Z' })] });
      expect(await screen.findByText(vi_['omni.config.waiting.note'])).toBeTruthy();
      expect(screen.queryByRole('button', { name: vi_['omni.config.verify.action'] })).toBeNull();
      act(() => {
        vi.advanceTimersByTime(35_000);
      });
      expect(screen.getByRole('button', { name: vi_['omni.config.verify.action'] })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts the form over when another account is opened, so what was typed for one is never sent for the other', async () => {
    const accounts = [accountRow(1), accountRow(2)];
    const { h } = open(
      <>
        <ChannelConfigScreen route={routeOf('OMNI-06', 'FR-OMNI-06')} />
        <Link to="/omni/omni-06?id=account-2">other account</Link>
      </>,
      SUPERVISOR,
      { accounts },
      () => ({ operation_id: 'o', status: 'ACTIVE', resource_version: 4, resource_id: 'account-2' }),
      '/omni/omni-06?id=account-1',
    );
    await screen.findByText(accountRow(1).display_name);
    fireEvent.change(screen.getByLabelText(vi_['omni.config.edit.displayName.label']), { target: { value: 'Typed for the first' } });
    fireEvent.click(screen.getByRole('link', { name: 'other account' }));
    await screen.findByRole('heading', { name: accountRow(2).display_name });
    expect((screen.getByLabelText(vi_['omni.config.edit.displayName.label']) as HTMLInputElement).value).toBe(accountRow(2).display_name);
    expect(h.command).not.toHaveBeenCalled();
  });

  it('closes an account after warning that it cannot be undone, and says in words when the account changed in the meantime', async () => {
    const { h } = configScreen(SUPERVISOR, { accounts: [accountRow(1)] }, () => problem('VERSION_CONFLICT', 409));
    await screen.findByText(accountRow(1).display_name);
    fireEvent.click(screen.getByRole('button', { name: vi_['omni.config.disable.action'] }));
    const panel = await screen.findByTestId('channel-disable');
    expect(within(panel).getByText(vi_['omni.config.disable.risk'])).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', { name: vi_['omni.config.confirm.action'] }));
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(panel).getByLabelText(vi_['omni.config.reason.label']), { target: { value: reason } });
    fireEvent.click(within(panel).getByRole('button', { name: vi_['omni.config.confirm.action'] }));
    expect(await within(panel).findByText(vi_['omni.channel.problem.conflict'])).toBeTruthy();
    expect(h.command).toHaveBeenCalledWith('disableChannelAccount', expect.objectContaining({ path: { channelAccountId: 'account-1' }, body: { reason }, ifMatchVersion: 3 }));
  });

  it('changes the name, the auto reply and the calendar with a reason, sending only what changed and an empty text for what was emptied', async () => {
    const { h } = configScreen(SUPERVISOR, { accounts: [accountRow(1, { auto_reply_text: 'We answer from 8:00.', calendar_code: 'VN-STD' })] }, () => ({ operation_id: 'o', status: 'ACTIVE', resource_version: 4, resource_id: 'account-1' }));
    await screen.findByText(accountRow(1).display_name);
    fireEvent.click(screen.getByRole('button', { name: vi_['omni.config.edit.save.action'] }));
    expect(await screen.findByText(vi_['omni.config.edit.invalid'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(vi_['omni.config.edit.displayName.label']), { target: { value: 'Hotline 24/7' } });
    fireEvent.change(screen.getByLabelText(vi_['omni.config.edit.autoReply.label']), { target: { value: '' } });
    fireEvent.change(within(document.querySelector('[data-edit]') as HTMLElement).getByLabelText(vi_['omni.config.reason.label']), { target: { value: reason } });
    fireEvent.click(screen.getByRole('button', { name: vi_['omni.config.edit.save.action'] }));
    expect(await screen.findByText(vi_['omni.config.done.saved'])).toBeTruthy();
    expect(h.command).toHaveBeenCalledWith(
      'updateChannelAccount',
      expect.objectContaining({ path: { channelAccountId: 'account-1' }, body: { display_name: 'Hotline 24/7', auto_reply_text: '', reason }, ifMatchVersion: 3 }),
    );
  });

  it('saves with the version the form was opened on, so a change made by someone else meanwhile is a conflict and not undone', async () => {
    const row = accountRow(1, { status: 'PendingVerification', verified_at: null, version: 3 });
    const { h } = configScreen(SUPERVISOR, { accounts: [row] }, (operation) => {
      // Someone else (here: a verification) changes the account after the form was opened, and the screen reads it again.
      if (operation === 'verifyChannelAccount') row.version = 4;
      return operation === 'updateChannelAccount' ? problem('VERSION_CONFLICT', 409) : { operation_id: 'o', status: 'VERIFICATION_REQUESTED', resource_version: 4, resource_id: 'account-1' };
    });
    await screen.findByText(row.display_name as string);
    fireEvent.change(screen.getByLabelText(vi_['omni.config.edit.displayName.label']), { target: { value: 'Typed on version 3' } });
    fireEvent.click(screen.getByRole('button', { name: vi_['omni.config.verify.action'] }));
    const panel = await screen.findByTestId('channel-verify');
    fireEvent.change(within(panel).getByLabelText(vi_['omni.config.reason.label']), { target: { value: reason } });
    fireEvent.click(within(panel).getByRole('button', { name: vi_['omni.config.confirm.action'] }));
    expect(await screen.findByText(vi_['omni.config.done.verify'])).toBeTruthy();
    await waitFor(() => expect(h.read.mock.calls.filter(([operation]) => operation === 'get_resources_channel_account_id').length).toBeGreaterThan(1));
    fireEvent.change(within(document.querySelector('[data-edit]') as HTMLElement).getByLabelText(vi_['omni.config.reason.label']), { target: { value: reason } });
    fireEvent.click(screen.getByRole('button', { name: vi_['omni.config.edit.save.action'] }));
    expect(await screen.findByText(vi_['omni.channel.problem.conflict'])).toBeTruthy();
    expect(h.command).toHaveBeenLastCalledWith('updateChannelAccount', expect.objectContaining({ ifMatchVersion: 3 }));
  });

  it('follows the account while nothing is typed: after the verification asked for here, the form saves on the new version', async () => {
    const row = accountRow(1, { status: 'PendingVerification', verified_at: null, version: 3 });
    const { h } = configScreen(SUPERVISOR, { accounts: [row] }, (operation) => {
      if (operation === 'verifyChannelAccount') {
        row.version = 4;
        row.display_name = 'Renamed meanwhile';
      }
      return { operation_id: 'o', status: 'OK', resource_version: 5, resource_id: 'account-1' };
    });
    await screen.findByText('Hotline 1');
    fireEvent.click(screen.getByRole('button', { name: vi_['omni.config.verify.action'] }));
    const panel = await screen.findByTestId('channel-verify');
    fireEvent.change(within(panel).getByLabelText(vi_['omni.config.reason.label']), { target: { value: reason } });
    fireEvent.click(within(panel).getByRole('button', { name: vi_['omni.config.confirm.action'] }));
    expect(await screen.findByText(vi_['omni.config.done.verify'])).toBeTruthy();
    await waitFor(() => expect((screen.getByLabelText(vi_['omni.config.edit.displayName.label']) as HTMLInputElement).value).toBe('Renamed meanwhile'));
    fireEvent.change(screen.getByLabelText(vi_['omni.config.edit.autoReply.label']), { target: { value: 'We answer from 8:00.' } });
    fireEvent.change(within(document.querySelector('[data-edit]') as HTMLElement).getByLabelText(vi_['omni.config.reason.label']), { target: { value: reason } });
    fireEvent.click(screen.getByRole('button', { name: vi_['omni.config.edit.save.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenLastCalledWith('updateChannelAccount', expect.objectContaining({ ifMatchVersion: 4 })));
  });

  it('offers a reader the facts and nothing to change', async () => {
    configScreen(READER, { accounts: [accountRow(1)] });
    await screen.findByText(accountRow(1).display_name);
    expect(document.querySelector('[data-edit]')).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['omni.config.disable.action'] })).toBeNull();
  });
});

describe('the model of OMNI-05 and OMNI-06', () => {
  it('reads an account and a page, and takes what is not one for nothing', () => {
    expect(toAccount(null)).toBeUndefined();
    expect(toAccount({ display_name: 'x' })).toBeUndefined();
    expect(toAccount(accountRow(1))).toMatchObject({ id: 'account-1', status: 'Active', credentialConfigured: true, webhookConfigured: true, verifyRequestedAt: undefined, verificationError: undefined, version: 3 });
    expect(toAccount(accountRow(1, { status: 'Weird' }))).toMatchObject({ status: 'PendingVerification' });
    expect(toAccountPage({ items: [accountRow(1), 4], next_cursor: 'c' })).toMatchObject({ nextCursor: 'c' });
    expect(toAccountPage(null)).toEqual({ items: [], nextCursor: undefined });
  });

  it('knows what may be done to an account in each state', () => {
    const view = (status: string, requested?: string) => toAccount(accountRow(1, { status, verify_requested_at: requested ?? null })) as NonNullable<ReturnType<typeof toAccount>>;
    expect(['PendingVerification', 'Active', 'Disabled', 'CredentialExpired'].map((status) => canVerify(view(status)))).toEqual([true, false, false, true]);
    const asked = '2026-10-30T03:00:00Z';
    const at = Date.parse(asked);
    expect(canVerify(view('PendingVerification', asked), at + 30_000)).toBe(false);
    // Asked for a minute ago and not answered: stranded, so it may be asked for again; an expired credential the same.
    expect(canVerify(view('PendingVerification', asked), at + 61_000)).toBe(true);
    expect(canVerify(view('Active', asked), at + 61_000)).toBe(false);
    expect(isWaiting(view('PendingVerification', asked))).toBe(true);
    expect(['PendingVerification', 'Active', 'Disabled', 'CredentialExpired'].map((status) => [canDisable(view(status)), canEdit(view(status))])).toEqual([[true, true], [true, true], [false, false], [true, true]]);
    expect([isReasonValid('short'), isReasonValid(reason), isReasonValid('x'.repeat(2001))]).toEqual([false, true, false]);
  });

  it('judges the form the way the server does, and sends a webhook secret only for a channel that has webhooks', () => {
    const form = { ...emptyConnectForm(), channel: 'WHATSAPP' as const, externalAccountId: '1048', displayName: 'Hotline', credentialSecretRef: 'secret://a/b', webhookSecretRef: 'secret://a/c' };
    expect(formProblems(form)).toEqual([]);
    expect(formProblems({ ...form, externalAccountId: ' ', displayName: ' ', credentialSecretRef: 'token', webhookSecretRef: 'token' })).toEqual(['externalAccountId', 'displayName', 'credentialSecretRef', 'webhookSecretRef']);
    expect(formProblems({ ...form, webhookSecretRef: 'secret://a/b' })).toEqual(['webhookSecretRef']);
    expect(connectBody(form)).toMatchObject({ webhook_secret_ref: 'secret://a/c' });
    expect(connectBody({ ...form, channel: 'PUSH_APNS' })).not.toHaveProperty('webhook_secret_ref');
    expect(formProblems({ ...form, channel: 'PUSH_APNS', webhookSecretRef: '' })).toEqual([]);
  });

  it('puts what the server refused with into words', () => {
    expect(describeProblem(problem('CHANNEL_ACCOUNT_EXISTS'))).toEqual({ reason: 'exists', field: undefined });
    expect(describeProblem(problem('CHANNEL_ACCOUNT_STATE_INVALID'))).toEqual({ reason: 'state', field: undefined });
    expect(describeProblem(problem('VALIDATION_FAILED', 422, 'calendar_code'))).toEqual({ reason: 'invalid', field: 'calendar_code' });
    expect(describeProblem(problem('VERSION_CONFLICT'))).toEqual({ reason: 'conflict', field: undefined });
    expect(describeProblem(problem('SCOPE_DENIED', 403))).toEqual({ reason: 'denied', field: undefined });
    expect(describeProblem(new Error('x'))).toEqual({ reason: 'general', field: undefined });
  });
});
