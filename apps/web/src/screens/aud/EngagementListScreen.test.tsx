import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import EngagementListScreen from './EngagementListScreen';
import { CONTRACT, DECISION, MANAGER, OTHER_PERSON, PROJECT, READER, SELF, client, engagementRecord, mount, routeOf, world } from './test-support';

const ROUTE = routeOf('AUD-02', 'FR-AUD-02');
const LINES = [
  engagementRecord(1, { status: 'ONGOING', legal_hold: { id: 'h1', status: 'Active' }, engagement_type: 'STATE_AUDIT', authority_kind: 'STATE_AUDIT_OFFICE', authority_name: 'Kiểm toán nhà nước khu vực II' }),
  engagementRecord(2),
  engagementRecord(3, { status: 'CANCELLED', legal_hold: { id: 'h3', status: 'Released' } }),
];

afterEach(cleanup);

const rowOf = (code: string): HTMLElement => screen.getByText(code).closest('tr') as HTMLElement;

describe('AUD-02 engagements', () => {
  it('lists the engagements with their kind, authority, period, status, coordinator and legal hold, and links each to its file', async () => {
    const h = client(world({ engagements: LINES }));
    mount(<EngagementListScreen route={ROUTE} />, h, { permissions: MANAGER });
    expect(await screen.findByText('TTCP-2026-001')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['aud.engagements.page.title']);
    const cells = within(rowOf('TTCP-2026-001')).getAllByRole('cell');
    expect(cells[1]?.textContent).toBe(vi_['aud.engagementType.stateAudit']);
    expect(cells[2]?.textContent).toContain('Kiểm toán nhà nước khu vực II');
    expect(cells[2]?.textContent).toContain(vi_['aud.authorityKind.stateAuditOffice']);
    expect(cells[3]?.textContent).toBe('2025-01-01 đến 2025-12-31');
    expect(cells[4]?.textContent).toBe(vi_['aud.engagementStatus.ongoing']);
    expect(cells[5]?.textContent).toBe('Nguyễn Văn An');
    expect(cells[6]?.textContent).toBe(vi_['aud.holdStatus.active']);
    expect(within(rowOf('TTCP-2026-002')).getAllByRole('cell')[6]?.textContent).toBe(vi_['aud.holdStatus.none']);
    expect(within(rowOf('TTCP-2026-003')).getAllByRole('cell')[6]?.textContent).toBe(vi_['aud.holdStatus.released']);
    expect(screen.getByRole('link', { name: 'TTCP-2026-002' }).getAttribute('href')).toBe(`/aud/aud-03?engagement=${LINES[1]?.id as string}`);
    expect(screen.getByTestId('engagement-count').textContent).toBe(vi_['aud.engagements.count.text'].replace('{count}', '3'));
    expect(screen.getByTestId('confidential-note').textContent).toBe(vi_['aud.engagements.confidential.note']);
  });

  it('asks the server for the status and the kind that were chosen, and filters by the words typed in the page', async () => {
    const h = client(world({ engagements: LINES }));
    mount(<EngagementListScreen route={ROUTE} />, h, { permissions: READER });
    await screen.findByText('TTCP-2026-001');
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText(vi_['aud.engagements.status.label']), 'CANCELLED');
    await waitFor(() => expect(screen.queryByText('TTCP-2026-001')).toBeNull());
    expect(screen.getByText('TTCP-2026-003')).toBeTruthy();
    expect((h.client.readAll as unknown as { mock: { calls: unknown[][] } }).mock.calls.some((call) => JSON.stringify(call[1]) === JSON.stringify({ query: { status: 'CANCELLED' } }))).toBe(true);
    await user.selectOptions(screen.getByLabelText(vi_['aud.engagements.status.label']), '');
    await user.selectOptions(screen.getByLabelText(vi_['aud.engagements.type.label']), 'STATE_AUDIT');
    await waitFor(() => expect(screen.queryByText('TTCP-2026-002')).toBeNull());
    expect(screen.getByText('TTCP-2026-001')).toBeTruthy();
    await user.selectOptions(screen.getByLabelText(vi_['aud.engagements.type.label']), '');
    await user.type(screen.getByLabelText(vi_['aud.engagements.search.label']), 'kiểm toán nhà nước');
    await waitFor(() => expect(screen.queryByText('TTCP-2026-002')).toBeNull());
    expect(screen.getByText('TTCP-2026-001')).toBeTruthy();
    await user.clear(screen.getByLabelText(vi_['aud.engagements.search.label']));
    await user.type(screen.getByLabelText(vi_['aud.engagements.search.label']), 'zzz');
    expect((await screen.findByTestId('no-engagements')).textContent).toBe(vi_['aud.engagements.none.text']);
    expect(screen.getByLabelText(vi_['aud.engagements.search.label'])).toBeTruthy();
  });

  it('offers the registration only to whoever may manage engagements in a tenant that is not read only', async () => {
    mount(<EngagementListScreen route={ROUTE} />, client(world({ engagements: LINES })), { permissions: READER });
    await screen.findByText('TTCP-2026-001');
    expect(screen.queryByRole('button', { name: vi_['aud.engagements.register.action'] })).toBeNull();
    cleanup();
    mount(<EngagementListScreen route={ROUTE} />, client(world({ engagements: LINES })), { permissions: MANAGER, mode: 'READ_ONLY' });
    await screen.findByText('TTCP-2026-001');
    expect(screen.queryByRole('button', { name: vi_['aud.engagements.register.action'] })).toBeNull();
    cleanup();
    mount(<EngagementListScreen route={ROUTE} />, client(world({ engagements: LINES })), { permissions: undefined });
    expect(await screen.findByRole('button', { name: vi_['aud.engagements.register.action'] })).toBeTruthy();
  });

  describe('the registration', () => {
    const ACCEPTED = { operation_id: 'o', status: 'PLANNED', resource_version: 1, resource_id: '00000000-0000-4000-8000-000000000f01' };

    async function open() {
      const h = client(world({ engagements: LINES }), () => ACCEPTED);
      mount(<EngagementListScreen route={ROUTE} />, h, { permissions: MANAGER });
      const user = userEvent.setup();
      await screen.findByText('TTCP-2026-001');
      await user.click(screen.getByRole('button', { name: vi_['aud.engagements.register.action'] }));
      return { h, user };
    }

    const dialog = (): HTMLElement => screen.getByRole('dialog');
    const field = (label: string): HTMLElement => within(dialog()).getByLabelText(label);

    it('checks the form before it sends anything and names every field that is wrong', async () => {
      const { h, user } = await open();
      await user.click(within(dialog()).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
      for (const label of ['code', 'type', 'authorityKind', 'authorityName', 'decision', 'title', 'periodFrom', 'periodTo'] as const) {
        expect(dialog().querySelector(`[data-field="engagement-${label === 'authorityKind' ? 'authority-kind' : label === 'authorityName' ? 'authority-name' : label === 'periodFrom' ? 'period-from' : label === 'periodTo' ? 'period-to' : label}"] .field-error`)).not.toBeNull();
      }
      expect(within(dialog()).getAllByRole('alert').length).toBeGreaterThanOrEqual(9);
      expect(h.command).not.toHaveBeenCalled();
      await user.type(field(vi_['aud.engagementDialog.decision.label']), 'not-a-uuid');
      await user.type(field(vi_['aud.engagementDialog.periodFrom.label']), '2025-12-31');
      await user.type(field(vi_['aud.engagementDialog.periodTo.label']), '2025-01-01');
      await user.click(within(dialog()).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
      expect(within(dialog()).getByText(vi_['aud.formProblem.invalid'])).toBeTruthy();
      expect(within(dialog()).getByText(vi_['aud.formProblem.order'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
    });

    it('sends the engagement with the kinds and ids of its scope, the decision in lower case and the person who registers it as coordinator, then closes', async () => {
      const { h, user } = await open();
      await user.type(field(vi_['aud.engagementDialog.code.label']), '  TTCP-2026-099 ');
      await user.selectOptions(field(vi_['aud.engagementDialog.type.label']), 'STATE_AUDIT');
      await user.selectOptions(field(vi_['aud.engagementDialog.authorityKind.label']), 'STATE_AUDIT_OFFICE');
      await user.type(field(vi_['aud.engagementDialog.authorityName.label']), 'Kiểm toán nhà nước');
      await user.type(field(vi_['aud.engagementDialog.decision.label']), DECISION.toUpperCase());
      await user.type(field(vi_['aud.engagementDialog.title.label']), 'Kiểm toán đầu tư cầu');
      await user.type(field(vi_['aud.engagementDialog.periodFrom.label']), '2025-01-01');
      await user.type(field(vi_['aud.engagementDialog.periodTo.label']), '2025-12-31');
      expect((field(vi_['aud.engagementDialog.coordinator.label']) as HTMLSelectElement).value).toBe(SELF);
      await user.selectOptions(field(vi_['aud.engagementDialog.coordinator.label']), OTHER_PERSON);
      // The scope: a project, then a contract; an item already added is not offered again, and an item can be taken out.
      const kind = within(dialog()).getByLabelText(vi_['aud.engagementDialog.scope.kind.label']);
      const place = within(dialog()).getByLabelText(vi_['aud.engagementDialog.scope.label']) as HTMLSelectElement;
      await waitFor(() => expect(Array.from(place.options).map((option) => option.value)).toContain(PROJECT));
      await user.selectOptions(place, PROJECT);
      await user.click(within(dialog()).getByRole('button', { name: vi_['aud.engagementDialog.scope.add'] }));
      expect(Array.from(place.options).map((option) => option.value)).not.toContain(PROJECT);
      await user.selectOptions(kind, 'CONTRACT');
      await waitFor(() => expect(Array.from(place.options).map((option) => option.value)).toContain(CONTRACT));
      await user.selectOptions(place, CONTRACT);
      await user.click(within(dialog()).getByRole('button', { name: vi_['aud.engagementDialog.scope.add'] }));
      expect(within(screen.getByTestId('scope-list')).getAllByRole('listitem')).toHaveLength(2);
      await user.click(within(dialog()).getByRole('button', { name: vi_['aud.engagementDialog.scope.remove'].replace('{code}', 'HD-A-001') }));
      expect(within(screen.getByTestId('scope-list')).getAllByRole('listitem')).toHaveLength(1);
      await user.selectOptions(kind, 'CONTRACT');
      await waitFor(() => expect(Array.from(place.options).map((option) => option.value)).toContain(CONTRACT));
      await user.selectOptions(place, CONTRACT);
      await user.click(within(dialog()).getByRole('button', { name: vi_['aud.engagementDialog.scope.add'] }));
      await user.click(within(dialog()).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('createAuditEngagement');
      expect((h.command.mock.calls[0]?.[1] as { body: unknown }).body).toEqual({
        engagement_code: 'TTCP-2026-099',
        engagement_type: 'STATE_AUDIT',
        authority_kind: 'STATE_AUDIT_OFFICE',
        authority_name: 'Kiểm toán nhà nước',
        decision_document_id: DECISION,
        title: 'Kiểm toán đầu tư cầu',
        period_from: '2025-01-01',
        period_to: '2025-12-31',
        coordinator_user_id: OTHER_PERSON,
        scope: [
          { kind: 'PROJECT', id: PROJECT },
          { kind: 'CONTRACT', id: CONTRACT },
        ],
      });
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('shows the refusal of the server in the dialog, keeps what was typed, and offers only the caller as coordinator when the directory cannot be read', async () => {
      const state = world({ engagements: LINES });
      state.failing.set('get_resources_membership', new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }));
      const h = client(state, () => new ApiError({ status: 409, code: 'ENGAGEMENT_CODE_DUPLICATE', correlationId: 'c' }));
      mount(<EngagementListScreen route={ROUTE} />, h, { permissions: MANAGER });
      const user = userEvent.setup();
      await screen.findByText('TTCP-2026-001');
      await user.click(screen.getByRole('button', { name: vi_['aud.engagements.register.action'] }));
      const coordinators = within(dialog()).getByLabelText(vi_['aud.engagementDialog.coordinator.label']) as HTMLSelectElement;
      expect(Array.from(coordinators.options).map((option) => option.value)).toEqual(['', SELF]);
      await user.type(field(vi_['aud.engagementDialog.code.label']), 'TTCP-2026-001');
      await user.selectOptions(field(vi_['aud.engagementDialog.type.label']), 'INTERNAL_AUDIT');
      await user.selectOptions(field(vi_['aud.engagementDialog.authorityKind.label']), 'INTERNAL');
      await user.type(field(vi_['aud.engagementDialog.authorityName.label']), 'Phòng kiểm toán nội bộ');
      await user.type(field(vi_['aud.engagementDialog.decision.label']), DECISION);
      await user.type(field(vi_['aud.engagementDialog.title.label']), 'Kiểm toán nội bộ');
      await user.type(field(vi_['aud.engagementDialog.periodFrom.label']), '2025-01-01');
      await user.type(field(vi_['aud.engagementDialog.periodTo.label']), '2025-12-31');
      const place = within(dialog()).getByLabelText(vi_['aud.engagementDialog.scope.label']) as HTMLSelectElement;
      await waitFor(() => expect(Array.from(place.options).map((option) => option.value)).toContain(PROJECT));
      await user.selectOptions(place, PROJECT);
      await user.click(within(dialog()).getByRole('button', { name: vi_['aud.engagementDialog.scope.add'] }));
      await user.click(within(dialog()).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
      expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(vi_['aud.problem.codeDuplicate']);
      expect((field(vi_['aud.engagementDialog.code.label']) as HTMLInputElement).value).toBe('TTCP-2026-001');
      await user.click(within(dialog()).getByRole('button', { name: vi_['aud.dialog.cancel.action'] }));
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('closes with Escape without sending anything', async () => {
      const { h, user } = await open();
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(h.command).not.toHaveBeenCalled();
    });
  });

  describe('the seven states', () => {
    const failing = (error: Error) => {
      const state = world();
      state.failing.set('listAuditEngagements', error);
      return client(state);
    };

    it('shows a loading state first, then the denied, signed-out, offline and error states', async () => {
      mount(<EngagementListScreen route={ROUTE} />, failing(new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' })), { permissions: READER });
      expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
      expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
      cleanup();
      mount(<EngagementListScreen route={ROUTE} />, failing(new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' })), { permissions: READER });
      expect(await screen.findByText(vi_['states.signedOut.title'])).toBeTruthy();
      cleanup();
      mount(<EngagementListScreen route={ROUTE} />, failing(new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' })), { permissions: READER });
      expect(await screen.findByText(vi_['states.offline.title'])).toBeTruthy();
      cleanup();
      mount(<EngagementListScreen route={ROUTE} />, failing(new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' })), { permissions: READER });
      expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
    });

    it('says there is no engagement when the scope of the caller holds none, and keeps the filters in reach', async () => {
      mount(<EngagementListScreen route={ROUTE} />, client(world()), { permissions: READER });
      expect((await screen.findByTestId('no-engagements')).textContent).toBe(vi_['aud.engagements.none.text']);
      expect(screen.getByLabelText(vi_['aud.engagements.status.label'])).toBeTruthy();
    });
  });
});
