import { NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { failure, harness, mount, routeOf } from './delivery/test-support';
import ConsentHistoryScreen from './ConsentHistoryScreen';

vi.setConfig({ testTimeout: 30_000 });

const ROUTE = routeOf('NOT-17', 'FR-NOT-17');
const MEMBER = ['notification.self'];

const GRANTED = { id: 'c-sms', channel: 'SMS', purpose: 'OPERATIONAL', status: 'Granted', effective_at: '2026-10-20T03:00:00.000Z', consent_text_version: 'consent-2026-1', version: 1 };
const WITHDRAWN = {
  id: 'c-zalo',
  channel: 'ZALO',
  purpose: 'REMINDER',
  status: 'Withdrawn',
  effective_at: '2026-10-01T03:00:00.000Z',
  revoked_at: '2026-10-10T03:00:00.000Z',
  consent_text_version: 'consent-2026-1',
  version: 2,
};

afterEach(cleanup);

function reads(items: unknown[], next: string | null = null) {
  return harness((operation) => (operation === 'listMyConsents' ? { items, next_cursor: next } : new Error(`unexpected read ${operation}`)), () => ({ operation_id: 'op', status: 'Granted', resource_version: 1, resource_id: 'c-new' }));
}

const rowOf = (id: string): HTMLElement => document.querySelector(`[data-consent-id="${id}"]`) as HTMLElement;

describe('NOT-17 consent history (UI-NOT-17, AC-ST-NOT-003-5)', () => {
  it('shows the consent history with the channel, the purpose, the status, the time and the version of the terms, and lists the locked inbox', async () => {
    mount(<ConsentHistoryScreen route={ROUTE} />, reads([GRANTED, WITHDRAWN]), { permissions: MEMBER });
    await waitFor(() => expect(rowOf('c-sms')).not.toBeNull());
    const granted = rowOf('c-sms');
    expect(within(granted).getByText('Tin nhắn SMS')).toBeTruthy();
    expect(within(granted).getByText('công việc')).toBeTruthy();
    expect(within(granted).getByText(vi_['not.consent.status.granted'])).toBeTruthy();
    expect(within(granted).getByText('consent-2026-1')).toBeTruthy();
    const ended = rowOf('c-zalo');
    expect(within(ended).getByText(vi_['not.consent.status.withdrawn'])).toBeTruthy();
    expect(within(ended).queryByRole('button', { name: vi_['not.consent.withdraw.action'] })).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: vi_['not.consent.page.title'] })).toBeTruthy();
    // The inbox is locked: it is listed as mandatory and has no switch or button.
    const locked = screen.getByTestId('locked-channels');
    expect(within(locked).getByText(vi_['not.consent.locked.inApp.name'])).toBeTruthy();
    expect(within(locked).queryByRole('button')).toBeNull();
    expect(within(locked).queryByRole('checkbox')).toBeNull();
  });

  it('needs a confirmation to withdraw: nothing is sent until a reason is given and confirmed, and the dismissal keeps the consent', async () => {
    const user = userEvent.setup();
    const h = reads([GRANTED]);
    mount(<ConsentHistoryScreen route={ROUTE} />, h, { permissions: MEMBER });
    await waitFor(() => expect(rowOf('c-sms')).not.toBeNull());
    await user.click(within(rowOf('c-sms')).getByRole('button', { name: vi_['not.consent.withdraw.action'] }));
    const panel = screen.getByTestId('withdraw-panel');
    expect(within(panel).getByText(/Có hiệu lực ngay/)).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    await user.click(within(panel).getByRole('button', { name: vi_['not.consent.withdraw.dismiss.action'] }));
    expect(screen.queryByTestId('withdraw-panel')).toBeNull();
    expect(h.command).not.toHaveBeenCalled();
    await user.click(within(rowOf('c-sms')).getByRole('button', { name: vi_['not.consent.withdraw.action'] }));
    await user.click(within(screen.getByTestId('withdraw-panel')).getByRole('button', { name: vi_['not.consent.withdraw.confirm.action'] }));
    expect(await screen.findByText(vi_['not.consent.withdraw.reason.error'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('withdraws under the version of the consent with the reason, and loads the history again', async () => {
    const user = userEvent.setup();
    const h = reads([GRANTED]);
    mount(<ConsentHistoryScreen route={ROUTE} />, h, { permissions: MEMBER });
    await waitFor(() => expect(rowOf('c-sms')).not.toBeNull());
    await user.click(within(rowOf('c-sms')).getByRole('button', { name: vi_['not.consent.withdraw.action'] }));
    await user.type(within(screen.getByTestId('withdraw-panel')).getByRole('textbox'), 'Tôi không muốn nhận tin nhắn nữa');
    await user.click(within(screen.getByTestId('withdraw-panel')).getByRole('button', { name: vi_['not.consent.withdraw.confirm.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command).toHaveBeenCalledWith('withdrawMyConsent', expect.objectContaining({ path: { consentId: 'c-sms' }, body: { reason: 'Tôi không muốn nhận tin nhắn nữa' }, ifMatchVersion: 1 }));
    await waitFor(() => expect(screen.queryByTestId('withdraw-panel')).toBeNull());
    await waitFor(() => expect(h.read.mock.calls.length).toBeGreaterThan(1));
  });

  it('shows why a withdrawal failed, by the code of the server, and keeps the panel open', async () => {
    const user = userEvent.setup();
    const h = reads([GRANTED]);
    h.command.mockRejectedValueOnce(failure(409, 'VERSION_CONFLICT'));
    mount(<ConsentHistoryScreen route={ROUTE} />, h, { permissions: MEMBER });
    await waitFor(() => expect(rowOf('c-sms')).not.toBeNull());
    await user.click(within(rowOf('c-sms')).getByRole('button', { name: vi_['not.consent.withdraw.action'] }));
    await user.type(within(screen.getByTestId('withdraw-panel')).getByRole('textbox'), 'Tôi không muốn nhận tin nhắn nữa');
    await user.click(within(screen.getByTestId('withdraw-panel')).getByRole('button', { name: vi_['not.consent.withdraw.confirm.action'] }));
    expect(await screen.findByTestId('withdraw-panel-problem')).toHaveTextContent(vi_['not.consent.problem.stale']);
  });

  it('gives a consent against the current text only after the member agrees, and says it was recorded', async () => {
    const user = userEvent.setup();
    const h = reads([]);
    mount(<ConsentHistoryScreen route={ROUTE} />, h, { permissions: MEMBER });
    const form = await screen.findByTestId('grant-form');
    await user.selectOptions(within(form).getByLabelText(vi_['not.consent.grant.channel.label']), 'ZALO');
    await user.selectOptions(within(form).getByLabelText(vi_['not.consent.grant.purpose.label']), 'REMINDER');
    await user.click(within(form).getByRole('button', { name: vi_['not.consent.grant.confirm.action'] }));
    expect(await within(form).findByText(vi_['not.consent.grant.agree.error'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    await user.click(within(form).getByRole('checkbox'));
    await user.click(within(form).getByRole('button', { name: vi_['not.consent.grant.confirm.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command).toHaveBeenCalledWith(
      'grantMyConsent',
      expect.objectContaining({ body: { channel: 'ZALO', purpose: 'REMINDER', consent_text_version: 'consent-2026-1', capture_method: 'IN_APP' } }),
    );
    expect(await screen.findByTestId('grant-done')).toHaveTextContent(vi_['not.consent.grant.done']);
  });

  it('does not offer a second consent for a channel and a purpose that are in force', async () => {
    const user = userEvent.setup();
    mount(<ConsentHistoryScreen route={ROUTE} />, reads([GRANTED]), { permissions: MEMBER });
    const form = await screen.findByTestId('grant-form');
    await waitFor(() => expect(rowOf('c-sms')).not.toBeNull());
    expect(within(form).getByTestId('grant-live')).toBeTruthy();
    expect(within(form).getByRole('button', { name: vi_['not.consent.grant.confirm.action'] })).toBeDisabled();
    await user.selectOptions(within(form).getByLabelText(vi_['not.consent.grant.purpose.label']), 'ANNOUNCEMENT');
    expect(within(form).queryByTestId('grant-live')).toBeNull();
    expect(within(form).getByRole('button', { name: vi_['not.consent.grant.confirm.action'] })).toBeEnabled();
  });

  it.each([
    ['the channel has no contact on the account', failure(422, 'CHANNEL_IDENTITY_UNVERIFIED'), vi_['not.consent.problem.identity']],
    ['the consent is already in force', failure(409, 'CONSENT_ALREADY_GRANTED'), vi_['not.consent.problem.alreadyGranted']],
    ['the server fails', failure(500, 'INTERNAL_ERROR'), vi_['not.consent.problem.general']],
  ])('says why a consent was not recorded when %s', async (_label, error, message) => {
    const user = userEvent.setup();
    const h = reads([]);
    h.command.mockRejectedValueOnce(error);
    mount(<ConsentHistoryScreen route={ROUTE} />, h, { permissions: MEMBER });
    const form = await screen.findByTestId('grant-form');
    await user.click(within(form).getByRole('checkbox'));
    await user.click(within(form).getByRole('button', { name: vi_['not.consent.grant.confirm.action'] }));
    expect(await screen.findByTestId('grant-problem')).toHaveTextContent(message);
  });

  it('is read-only in read-only mode: no consent can be given or withdrawn', async () => {
    mount(<ConsentHistoryScreen route={ROUTE} />, reads([GRANTED]), { permissions: MEMBER, mode: 'READ_ONLY' });
    await waitFor(() => expect(rowOf('c-sms')).not.toBeNull());
    expect(within(rowOf('c-sms')).getByRole('button', { name: vi_['not.consent.withdraw.action'] })).toBeDisabled();
    expect(within(screen.getByTestId('grant-form')).getByRole('button', { name: vi_['not.consent.grant.confirm.action'] })).toBeDisabled();
    expect(screen.getByText(vi_['not.consent.readOnly.message'])).toBeTruthy();
  });

  it('pages the history with the cursor of the server', async () => {
    const user = userEvent.setup();
    const h = harness(
      (operation, input) => {
        if (operation !== 'listMyConsents') return new Error(`unexpected read ${operation}`);
        const query = (input as { query: { cursor?: string } }).query;
        return query.cursor === undefined ? { items: [GRANTED], next_cursor: 'c2' } : { items: [WITHDRAWN], next_cursor: null };
      },
      () => ({}),
    );
    mount(<ConsentHistoryScreen route={ROUTE} />, h, { permissions: MEMBER });
    await waitFor(() => expect(rowOf('c-sms')).not.toBeNull());
    expect(rowOf('c-zalo')).toBeNull();
    await user.click(screen.getByRole('button', { name: vi_['not.consent.history.more.action'] }));
    await waitFor(() => expect(rowOf('c-zalo')).not.toBeNull());
    expect(h.read).toHaveBeenLastCalledWith('listMyConsents', { query: { limit: 25, cursor: 'c2' } });
  });

  it('leaves out an item the server sent that cannot be read, rather than showing it half', async () => {
    mount(<ConsentHistoryScreen route={ROUTE} />, reads([GRANTED, { id: 'bad', channel: 'SMS' }, null, { ...WITHDRAWN, status: 'Mystery' }]), { permissions: MEMBER });
    await waitFor(() => expect(rowOf('c-sms')).not.toBeNull());
    expect(document.querySelectorAll('[data-consent-id]')).toHaveLength(1);
  });
});

describe('NOT-17 consent history: the seven states (AC-ST-NOT-003-5)', () => {
  it('shows the loading state while the history is on its way', async () => {
    const h = reads([]);
    h.read.mockImplementation(() => new Promise(() => undefined));
    mount(<ConsentHistoryScreen route={ROUTE} />, h, { permissions: MEMBER });
    expect(await screen.findByRole('status', { name: 'Đang tải' })).toHaveAttribute('aria-busy', 'true');
  });

  it('shows the empty state for a member who never gave a consent, and still offers the form', async () => {
    mount(<ConsentHistoryScreen route={ROUTE} />, reads([]), { permissions: MEMBER });
    expect(await screen.findByText('Chưa có dữ liệu')).toBeInTheDocument();
    expect(screen.getByTestId('grant-form')).toBeTruthy();
  });

  it.each([
    ['an error', failure(500, 'INTERNAL_ERROR'), /Chưa thể tải dữ liệu/],
    ['a refusal', failure(403, 'SCOPE_DENIED'), /Bạn chưa có quyền truy cập/],
    ['a lapsed session', failure(401, 'SESSION_EXPIRED'), /Phiên làm việc đã hết hạn/],
    ['a failed network', failure(0, NETWORK_ERROR_CODE), /Bạn đang ngoại tuyến/],
  ])('shows its own state for %s', async (_label, error, wording) => {
    mount(<ConsentHistoryScreen route={ROUTE} />, harness(() => error), { permissions: MEMBER });
    expect(await screen.findByText(wording)).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });
});
