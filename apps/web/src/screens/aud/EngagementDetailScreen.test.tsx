import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import EngagementDetailScreen from './EngagementDetailScreen';
import { MANAGER, READER, client, detailRecord, mount, routeOf, world } from './test-support';

const ROUTE = routeOf('AUD-03', 'FR-AUD-03');
const ID = detailRecord(1).id as string;
const PATH = `/aud/aud-03?engagement=${ID}`;

afterEach(cleanup);

const stateOf = (overrides: Record<string, unknown>) => world({ details: { [ID]: detailRecord(1, overrides) } });
const open = (overrides: Record<string, unknown> = {}, permissions: readonly string[] | undefined = MANAGER, command: (operation: string, input: unknown) => unknown = () => ({ status: 'OK' })) => {
  const h = client(stateOf(overrides), command);
  mount(<EngagementDetailScreen route={ROUTE} />, h, { permissions, path: PATH });
  return h;
};
const names = (): string[] => within(document.querySelector('.actions') as HTMLElement).getAllByRole('button').map((button) => button.textContent ?? '');

describe('AUD-03 file of an engagement', () => {
  it('shows the decision, the authority, the period and the milestones, the scope with its names and the legal hold', async () => {
    open({ status: 'ONGOING', started_on: '2026-10-20', legal_hold: { id: 'h1', status: 'Active' } });
    expect(await screen.findByRole('heading', { level: 1, name: vi_['aud.engagement.file.title'].replace('{code}', 'TTCP-2026-001') })).toBeTruthy();
    const decision = within(screen.getByTestId('decision-card'));
    expect(decision.getByText('Quyết định thanh tra cầu')).toBeTruthy();
    expect(decision.getByText('12/QD-TTCP')).toBeTruthy();
    expect(decision.getByText('2026-01-15')).toBeTruthy();
    expect(decision.getByText(`Thanh tra tỉnh Cao Bằng (${vi_['aud.authorityKind.provincialInspectorate']})`)).toBeTruthy();
    expect(decision.getByText('Nguyễn Văn An')).toBeTruthy();
    const period = within(screen.getByTestId('period-card'));
    expect(period.getByText(vi_['aud.engagementStatus.ongoing'])).toBeTruthy();
    expect(period.getByText('2026-10-20')).toBeTruthy();
    expect(period.queryByTestId('cancel-reason')).toBeNull();
    const hold = within(screen.getByTestId('hold-card'));
    expect(hold.getByText(vi_['aud.holdStatus.active'])).toBeTruthy();
    expect(hold.getByText(vi_['aud.engagement.hold.covers'].replace('{count}', '2'))).toBeTruthy();
    const rows = screen.getAllByRole('row').slice(1).map((row) => within(row).getAllByRole('cell').map((cell) => cell.textContent));
    expect(rows).toEqual([
      [vi_['aud.scopeKind.contract'], 'HD-A-001', 'Hợp đồng thi công cầu'],
      [vi_['aud.scopeKind.project'], 'DA-2026-001', 'Cầu qua sông'],
    ]);
    expect(screen.getByRole('link', { name: vi_['aud.engagement.back.link'] }).getAttribute('href')).toBe('/aud/aud-02');
    expect(screen.getByTestId('confidential-note').textContent).toBe(vi_['aud.engagement.confidential.note']);
  });

  it('says so when there is no hold, shows the reason of a cancellation, and falls back on the ids when the names are not known', async () => {
    open({
      status: 'CANCELLED',
      cancel_reason: 'Cơ quan đã rút quyết định.',
      decision: { document_id: '00000000-0000-4000-8000-000000000f99', title: '', symbol: null, issued_on: null, effect_status: 'RECALLED' },
      coordinator: { id: '00000000-0000-4000-8000-000000000f98', display_name: '' },
    });
    expect((await screen.findByTestId('cancel-reason')).textContent).toBe('Cơ quan đã rút quyết định.');
    expect(within(screen.getByTestId('hold-card')).getByText(vi_['aud.engagement.hold.none'])).toBeTruthy();
    expect(within(screen.getByTestId('decision-card')).getByText('00000000-0000-4000-8000-000000000f99')).toBeTruthy();
    expect(within(screen.getByTestId('decision-card')).getByText('00000000-0000-4000-8000-000000000f98')).toBeTruthy();
    expect(within(screen.getByTestId('decision-card')).getAllByText('—').length).toBeGreaterThanOrEqual(2);
  });

  it('offers the commands that fit the state, to whoever may manage engagements and in a tenant that is not read only', async () => {
    open({ status: 'PLANNED' });
    await screen.findByTestId('period-card');
    expect(names()).toEqual([vi_['aud.engagement.start.action'], vi_['aud.engagement.cancel.action']]);
    cleanup();
    open({ status: 'ONGOING' });
    await screen.findByTestId('period-card');
    expect(names()).toEqual([vi_['aud.engagement.endFieldwork.action'], vi_['aud.engagement.cancel.action']]);
    cleanup();
    open({ status: 'AWAITING_CONCLUSION' });
    await screen.findByTestId('period-card');
    expect(names()).toEqual([vi_['aud.engagement.cancel.action']]);
    for (const status of ['FOLLOW_UP', 'CLOSED', 'CANCELLED']) {
      cleanup();
      open({ status });
      await screen.findByTestId('period-card');
      expect(document.querySelector('.actions')).toBeNull();
    }
    cleanup();
    open({ status: 'PLANNED' }, READER);
    await screen.findByTestId('period-card');
    expect(document.querySelector('.actions')).toBeNull();
  });

  it('starts the engagement on the day chosen with the version the screen showed, asking for the legal hold by default', async () => {
    const h = open({ status: 'PLANNED', version: 4 });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: vi_['aud.engagement.start.action'] }));
    const dialog = screen.getByRole('dialog');
    expect((within(dialog).getByLabelText(vi_['aud.engagementDialog.placeHold.label']) as HTMLInputElement).checked).toBe(true);
    await user.clear(within(dialog).getByLabelText(vi_['aud.engagementDialog.startedOn.label']));
    await user.type(within(dialog).getByLabelText(vi_['aud.engagementDialog.startedOn.label']), '2999-01-01');
    await user.click(within(dialog).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
    expect(within(dialog).getByText(vi_['aud.formProblem.future'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    await user.clear(within(dialog).getByLabelText(vi_['aud.engagementDialog.startedOn.label']));
    await user.type(within(dialog).getByLabelText(vi_['aud.engagementDialog.startedOn.label']), '2026-10-20');
    await user.click(within(dialog).getByLabelText(vi_['aud.engagementDialog.placeHold.label']));
    await user.click(within(dialog).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]?.[0]).toBe('startAuditEngagement');
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: ID }, body: { started_on: '2026-10-20', place_legal_hold: false }, ifMatchVersion: 4 });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('ends the fieldwork on a day between the start and today', async () => {
    const h = open({ status: 'ONGOING', started_on: '2026-10-20', version: 2 });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: vi_['aud.engagement.endFieldwork.action'] }));
    const dialog = screen.getByRole('dialog');
    await user.clear(within(dialog).getByLabelText(vi_['aud.engagementDialog.endOn.label']));
    await user.type(within(dialog).getByLabelText(vi_['aud.engagementDialog.endOn.label']), '2026-10-19');
    await user.click(within(dialog).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
    expect(within(dialog).getByText(vi_['aud.formProblem.early'])).toBeTruthy();
    await user.clear(within(dialog).getByLabelText(vi_['aud.engagementDialog.endOn.label']));
    await user.type(within(dialog).getByLabelText(vi_['aud.engagementDialog.endOn.label']), '2026-10-21');
    await user.click(within(dialog).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]?.[0]).toBe('endAuditFieldwork');
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: ID }, body: { on_date: '2026-10-21' }, ifMatchVersion: 2 });
  });

  it('cancels with a reason in words and tells the refusal of the server when the engagement has changed', async () => {
    const h = open({ status: 'ONGOING', started_on: '2026-10-20' }, MANAGER, () => new ApiError({ status: 409, code: 'CONCLUSION_EXISTS', correlationId: 'c' }));
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: vi_['aud.engagement.cancel.action'] }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
    expect(within(dialog).getByText(vi_['aud.formProblem.required'])).toBeTruthy();
    await user.type(within(dialog).getByLabelText(vi_['aud.engagementDialog.cancelReason.label']), 'short');
    await user.click(within(dialog).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
    expect(within(dialog).getByText(vi_['aud.formProblem.tooShort'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    await user.clear(within(dialog).getByLabelText(vi_['aud.engagementDialog.cancelReason.label']));
    await user.type(within(dialog).getByLabelText(vi_['aud.engagementDialog.cancelReason.label']), 'Cơ quan đã rút quyết định thanh tra.');
    await user.click(within(dialog).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
    expect((await within(dialog).findByTestId('refusal')).textContent).toBe(vi_['aud.problem.conclusionExists']);
    expect(h.command.mock.calls[0]?.[0]).toBe('cancelAuditEngagement');
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ body: { reason: 'Cơ quan đã rút quyết định thanh tra.' } });
    expect(screen.getByRole('dialog')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: vi_['aud.dialog.close.label'] }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  describe('the seven states', () => {
    it('says the engagement is not there for an address without an engagement and for one that is not found (the same words as an engagement of another scope)', async () => {
      mount(<EngagementDetailScreen route={ROUTE} />, client(world()), { permissions: READER, path: '/aud/aud-03' });
      expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
      cleanup();
      mount(<EngagementDetailScreen route={ROUTE} />, client(world()), { permissions: READER, path: PATH });
      expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
      expect(screen.queryByTestId('decision-card')).toBeNull();
    });

    it('shows a loading state first, then the denied, signed-out, offline and error states', async () => {
      const failing = (error: Error) => {
        const state = world();
        state.failing.set('getAuditEngagement', error);
        return client(state);
      };
      mount(<EngagementDetailScreen route={ROUTE} />, failing(new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' })), { permissions: READER, path: PATH });
      expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
      expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
      cleanup();
      mount(<EngagementDetailScreen route={ROUTE} />, failing(new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' })), { permissions: READER, path: PATH });
      expect(await screen.findByText(vi_['states.signedOut.title'])).toBeTruthy();
      cleanup();
      mount(<EngagementDetailScreen route={ROUTE} />, failing(new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' })), { permissions: READER, path: PATH });
      expect(await screen.findByText(vi_['states.offline.title'])).toBeTruthy();
      cleanup();
      mount(<EngagementDetailScreen route={ROUTE} />, failing(new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' })), { permissions: READER, path: PATH });
      expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
    });
  });
});
