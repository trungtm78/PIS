import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import SupportAccessScreen from './SupportAccessScreen';
import { approvalsGiven, approvalsNeeded, canDecide, canRevoke, describeProblem, toGrant, toGrantPage } from './support/model';
import { harness, mount, routeOf } from './test-support';

const ROUTE = routeOf('SAS-19', 'FR-SAS-19');
const OPERATOR = ['system.support.request'];
const APPROVER = ['tenant.support.approve', 'support_access_grant.read'];
const READER = ['support_access_grant.read'];
const TENANT = '00000000-0000-4000-8000-0000000000a1';
/** The membership of the session of the tests (see test-support). */
const ME = '00000000-0000-4000-8000-0000000000e9';
const SOMEONE = '00000000-0000-4000-8000-0000000000f2';
const OPERATOR_ID = '00000000-0000-4000-8000-0000000000d1';

const grant = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `grant-${n}`,
  tenant_id: TENANT,
  ticket_reference: `SUP-2026-00000${n}`,
  operator_id: OPERATOR_ID,
  access_mode: 'READ_ONLY',
  status: 'Requested',
  in_force: false,
  scope: { modules: ['CTR', 'DOC'], resource_ids: [] },
  duration_minutes: 60,
  request_reason: 'The customer cannot open a contract.',
  requested_at: '2026-10-30T02:00:00Z',
  starts_at: null,
  expires_at: '2026-10-30T03:00:00Z',
  approved_by: null,
  second_approver_id: null,
  revoked_at: null,
  revoke_reason: null,
  version: 1,
  ...overrides,
});

const page = (items: Array<Record<string, unknown>>, next: string | null = null) => ({ items, next_cursor: next });
const reasonText = 'The customer asked for it in the ticket.';

afterEach(cleanup);

function open(items: Array<Record<string, unknown>> | Error, permissions: readonly string[], command: (operation: string, input: unknown) => unknown = () => ({ status: 'ACTIVE' })) {
  const h = harness((operation, input) => {
    if (operation !== 'get_resources_support_access_grant') return new Error(`unexpected read ${operation}`);
    if (items instanceof Error) return items;
    // The banner asks for the grants in force by themselves, the list asks for the history.
    return (input as { query?: { in_force?: boolean } } | undefined)?.query?.in_force === true ? page(items.filter((item) => item.in_force === true)) : page(items);
  }, command);
  const element = <SupportAccessScreen route={ROUTE} />;
  const address = `/sas/sas-19?tenant=${TENANT}`;
  return { h, ...mount(element, h, permissions, address) };
}

describe('SAS-19 controlled support access: the operator (UI-SAS-19)', () => {
  it('shows the request form with the tenant of the address, and no list of grants: the operator reads nothing of the tenant', async () => {
    const { h } = open([], OPERATOR);
    expect(await screen.findByRole('form', { name: vi_['sas.support.request.aria'] })).toBeTruthy();
    expect((screen.getByLabelText(vi_['sas.support.request.tenant.label']) as HTMLInputElement).value).toBe(TENANT);
    expect(screen.getByLabelText(vi_['sas.support.mode.readOnly'])).toBeTruthy();
    expect(screen.getByLabelText(vi_['sas.support.mode.readWrite'])).toBeTruthy();
    expect(screen.queryByText(vi_['sas.support.grants.title'])).toBeNull();
    expect(h.read).not.toHaveBeenCalled();
  });

  it('refuses a request that is not complete, saying what is missing, and sends nothing', async () => {
    const { h } = open([], OPERATOR);
    fireEvent.change(await screen.findByLabelText(vi_['sas.support.request.tenant.label']), { target: { value: 'not-a-tenant' } });
    fireEvent.change(screen.getByLabelText(/Thời lượng/), { target: { value: '600' } });
    fireEvent.click(screen.getByRole('button', { name: vi_['sas.support.request.submit.action'] }));
    expect(await screen.findByText(vi_['sas.support.request.tenant.invalid'])).toBeTruthy();
    expect(screen.getByText(vi_['sas.support.request.ticket.invalid'])).toBeTruthy();
    expect(screen.getByText(vi_['sas.support.request.modules.invalid'])).toBeTruthy();
    expect(screen.getByText(/Thời lượng phải là số nguyên/)).toBeTruthy();
    expect(screen.getByText(vi_['sas.support.request.reason.tooShort'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('sends the request with the ticket, the modules, the mode, the minutes and the reason, and says it gives nothing until the tenant consents', async () => {
    const { h } = open([], OPERATOR, () => ({ status: 'REQUESTED' }));
    fireEvent.change(await screen.findByLabelText(vi_['sas.support.request.ticket.label']), { target: { value: 'SUP-2026-000123' } });
    fireEvent.click(screen.getByLabelText('CTR'));
    fireEvent.click(screen.getByLabelText('DOC'));
    fireEvent.click(screen.getByLabelText(vi_['sas.support.mode.readWrite']));
    expect(screen.getByText(vi_['sas.support.request.mode.writeNote'])).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Thời lượng/), { target: { value: '90' } });
    fireEvent.change(screen.getByLabelText(vi_['sas.support.request.reason.label']), { target: { value: reasonText } });
    fireEvent.click(screen.getByRole('button', { name: vi_['sas.support.request.submit.action'] }));
    expect(await screen.findByText(vi_['sas.support.request.done'])).toBeTruthy();
    expect(h.command).toHaveBeenCalledTimes(1);
    const [operation, input] = h.command.mock.calls[0] as [string, { body: unknown }];
    expect(operation).toBe('requestSupportAccess');
    expect(input.body).toEqual({ tenant_id: TENANT, ticket_reference: 'SUP-2026-000123', scope: { modules: ['CTR', 'DOC'] }, access_mode: 'READ_WRITE', duration_minutes: 90, reason: reasonText });
    expect((screen.getByLabelText(vi_['sas.support.request.ticket.label']) as HTMLInputElement).value).toBe('');
  });

  it('says why a request was refused: no such ticket, or one already open', async () => {
    const refusal = (code: string, status: number) => new ApiError({ status, code, correlationId: 'c' });
    for (const [error, message] of [
      [refusal('TICKET_NOT_FOUND', 404), vi_['sas.support.problem.ticket']],
      [refusal('SUPPORT_GRANT_INVALID', 409), vi_['sas.support.problem.grantState']],
    ] as const) {
      open([], OPERATOR, () => error);
      fireEvent.change(await screen.findByLabelText(vi_['sas.support.request.ticket.label']), { target: { value: 'SUP-2026-000123' } });
      fireEvent.click(screen.getByLabelText('CTR'));
      fireEvent.change(screen.getByLabelText(vi_['sas.support.request.reason.label']), { target: { value: reasonText } });
      fireEvent.click(screen.getByRole('button', { name: vi_['sas.support.request.submit.action'] }));
      expect((await screen.findByRole('alert')).textContent).toContain(message);
      cleanup();
    }
  });
});

describe('SAS-19 controlled support access: the people of the tenant (UI-SAS-19)', () => {
  it('lists the requests with the ticket, the mode, the modules, the status and how many consents are given, and offers the form of the request to nobody who cannot make one', async () => {
    open([grant(1), grant(2, { access_mode: 'READ_WRITE', approved_by: SOMEONE })], APPROVER);
    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.getAttribute('data-status')).toBe('Requested');
    expect(within(rows[0] as HTMLElement).getByText(vi_['sas.support.mode.readOnly'])).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText('CTR, DOC')).toBeTruthy();
    expect(rows[0]?.querySelector('[data-approvals]')?.textContent).toBe('0/1');
    expect(rows[1]?.querySelector('[data-approvals]')?.textContent).toBe('1/2');
    expect(screen.queryByRole('form', { name: vi_['sas.support.request.aria'] })).toBeNull();
  });

  it('shows a banner naming who is in, how, where and until when, only while a grant is in force', async () => {
    open([grant(1), grant(2, { status: 'Active', in_force: true, starts_at: '2026-10-30T02:00:00Z', approved_by: SOMEONE })], APPROVER);
    const banner = await waitFor(() => {
      const found = document.querySelector('[data-support-banner]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(banner.textContent).toContain(OPERATOR_ID);
    expect(banner.textContent).toContain('CTR, DOC');
    expect(banner.querySelectorAll('li')).toHaveLength(1);
    expect(banner.querySelector('[data-grant-id="grant-2"]')).not.toBeNull();
    cleanup();
    open([grant(1), grant(3, { status: 'Expired' })], APPROVER);
    await screen.findByRole('table');
    expect(document.querySelector('[data-support-banner]')).toBeNull();
  });

  it('shows the banner for a grant in force that is not on the page of the history that was read', async () => {
    const h = harness((operation, input) => {
      const query = (input as { query?: { in_force?: boolean } } | undefined)?.query;
      if (operation !== 'get_resources_support_access_grant') return new Error('unexpected');
      return query?.in_force === true ? page([grant(9, { status: 'Active', in_force: true, approved_by: SOMEONE })]) : page([grant(1)], 'next');
    });
    const element = <SupportAccessScreen route={ROUTE} />;
    mount(element, h, APPROVER, `/sas/sas-19?tenant=${TENANT}`);
    await screen.findByRole('table');
    await waitFor(() => expect(document.querySelector('[data-support-banner] [data-grant-id="grant-9"]')).not.toBeNull());
    expect(screen.queryByText(vi_['sas.support.grants.more.action'])).not.toBeNull();
  });

  it('reads the grants and the notice of access in force again while the screen stays open, so a grant that starts, ends or is revoked elsewhere shows', async () => {
    const { queries } = open([grant(1)], APPROVER);
    await screen.findByRole('table');
    const intervals = queries
      .getQueryCache()
      .getAll()
      .map((query) => query.observers[0]?.options.refetchInterval);
    expect(intervals).toHaveLength(2);
    expect(intervals.every((interval) => interval === 30_000)).toBe(true);
  });

  it('approves a request with the reason and the version it saw, and shows what was done', async () => {
    const { h } = open([grant(1, { version: 4 })], APPROVER);
    fireEvent.click(await screen.findByRole('button', { name: vi_['sas.support.approve.action'] }));
    // The reason is required, and the form says so.
    fireEvent.click(screen.getByRole('button', { name: vi_['sas.support.act.confirm.action'] }));
    expect(await screen.findByText(vi_['sas.support.act.reason.tooShort'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(vi_['sas.support.act.reason.label']), { target: { value: reasonText } });
    fireEvent.click(screen.getByRole('button', { name: vi_['sas.support.act.confirm.action'] }));
    expect(await screen.findByText(vi_['sas.support.done.approved'])).toBeTruthy();
    expect(h.command).toHaveBeenCalledTimes(1);
    const [operation, input] = h.command.mock.calls[0] as [string, { path: unknown; body: unknown; ifMatchVersion: number }];
    expect(operation).toBe('post_support_access_id_approve');
    expect(input.path).toEqual({ id: 'grant-1' });
    expect(input.body).toEqual({ decision: 'approve', reason: reasonText });
    expect(input.ifMatchVersion).toBe(4);
  });

  it('rejects with the decision reject, and revokes a grant in force with the revoke command', async () => {
    const { h } = open([grant(1), grant(2, { status: 'Active', in_force: true, approved_by: SOMEONE })], APPROVER);
    const rows = (await screen.findAllByRole('row')).slice(1);
    fireEvent.click(within(rows[0] as HTMLElement).getByRole('button', { name: vi_['sas.support.reject.action'] }));
    fireEvent.change(screen.getByLabelText(vi_['sas.support.act.reason.label']), { target: { value: reasonText } });
    fireEvent.click(screen.getByRole('button', { name: vi_['sas.support.act.confirm.action'] }));
    expect(await screen.findByText(vi_['sas.support.done.rejected'])).toBeTruthy();
    expect((h.command.mock.calls[0] as [string, { body: unknown }])[1].body).toEqual({ decision: 'reject', reason: reasonText });
    const again = (await screen.findAllByRole('row')).slice(1);
    // A grant in force cannot be approved or rejected again, only revoked.
    expect(within(again[1] as HTMLElement).queryByRole('button', { name: vi_['sas.support.approve.action'] })).toBeNull();
    fireEvent.click(within(again[1] as HTMLElement).getByRole('button', { name: vi_['sas.support.revoke.action'] }));
    fireEvent.change(screen.getByLabelText(vi_['sas.support.act.reason.label']), { target: { value: 'The work is done, thank you.' } });
    fireEvent.click(screen.getByRole('button', { name: vi_['sas.support.act.confirm.action'] }));
    expect(await screen.findByText(vi_['sas.support.done.revoked'])).toBeTruthy();
    const [operation, input] = h.command.mock.calls[1] as [string, { path: unknown; body: unknown }];
    expect(operation).toBe('revokeSupportAccess');
    expect(input.path).toEqual({ id: 'grant-2' });
    expect(input.body).toEqual({ reason: 'The work is done, thank you.' });
  });

  it('does not offer the second consent of a write to the person who gave the first, and explains the rule of two people', async () => {
    open([grant(1, { access_mode: 'READ_WRITE', approved_by: ME }), grant(2, { access_mode: 'READ_WRITE', approved_by: SOMEONE })], APPROVER);
    const rows = (await screen.findAllByRole('row')).slice(1);
    expect(within(rows[0] as HTMLElement).queryByRole('button', { name: vi_['sas.support.approve.action'] })).toBeNull();
    expect(within(rows[0] as HTMLElement).getByRole('button', { name: vi_['sas.support.revoke.action'] })).toBeTruthy();
    fireEvent.click(within(rows[1] as HTMLElement).getByRole('button', { name: vi_['sas.support.approve.action'] }));
    expect(screen.getByText(vi_['sas.support.act.approve.writeRule'])).toBeTruthy();
  });

  it('says why a decision was refused, and offers no action to somebody who may only read', async () => {
    open([grant(1)], APPROVER, () => new ApiError({ status: 403, code: 'SELF_APPROVAL_DENIED', correlationId: 'c' }));
    fireEvent.click(await screen.findByRole('button', { name: vi_['sas.support.approve.action'] }));
    fireEvent.change(screen.getByLabelText(vi_['sas.support.act.reason.label']), { target: { value: reasonText } });
    fireEvent.click(screen.getByRole('button', { name: vi_['sas.support.act.confirm.action'] }));
    expect((await screen.findByRole('alert')).textContent).toContain(vi_['sas.support.problem.selfApproval']);
    cleanup();
    open([grant(1), grant(2, { status: 'Active', in_force: true, approved_by: SOMEONE })], READER);
    await screen.findByRole('table');
    expect(screen.queryByRole('button', { name: vi_['sas.support.approve.action'] })).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['sas.support.revoke.action'] })).toBeNull();
  });

  it('has no way to extend a grant: only a new request does, and the people of the tenant see none to make', async () => {
    open([grant(1, { status: 'Active', in_force: true, approved_by: SOMEONE })], APPROVER);
    await screen.findByRole('table');
    expect(screen.queryByRole('button', { name: /gia hạn|kéo dài|extend/i })).toBeNull();
  });

  it('shows the next page when there is one', async () => {
    const h = harness((operation, input) => {
      const cursor = (input as { query?: { cursor?: string } } | undefined)?.query?.cursor;
      return operation === 'get_resources_support_access_grant' ? (cursor === undefined ? page([grant(1)], 'next') : page([grant(2)])) : new Error('unexpected');
    });
    const element = <SupportAccessScreen route={ROUTE} />;
    mount(element, h, APPROVER, `/sas/sas-19?tenant=${TENANT}`);
    fireEvent.click(await screen.findByRole('button', { name: vi_['sas.support.grants.more.action'] }));
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(3));
  });
});

describe('the seven states of SAS-19 (AC-ST-SAS-015-4, UI-SAS-19)', () => {
  const failing = (error: ApiError) => open(error, APPROVER);

  it('AC-ST-SAS-015-4 UI-SAS-19: shows a loading state first, then the denied, signed-out, offline and error states', async () => {
    failing(new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }));
    expect(screen.getByRole('status')).toBeTruthy();
    expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
    cleanup();
    failing(new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' }));
    expect(await screen.findByText(vi_['states.signedOut.title'])).toBeTruthy();
    cleanup();
    failing(new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }));
    expect(await screen.findByText(vi_['states.offline.title'])).toBeTruthy();
    cleanup();
    failing(new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' }));
    expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
  });

  it('AC-ST-SAS-015-4 UI-SAS-19: says in words that there is nothing yet, with the page title', async () => {
    open([], APPROVER);
    expect(await screen.findByText(vi_['sas.support.grants.none'])).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['sas.support.page.title']);
  });
});

describe('the model of SAS-19', () => {
  it('reads a grant as the tenant is shown it, and takes what is not a grant for nothing', () => {
    expect(toGrant(null)).toBeUndefined();
    expect(toGrant({ ticket_reference: 'x' })).toBeUndefined();
    expect(toGrantPage(grant(1))).toEqual({ items: [], nextCursor: undefined });
    const view = toGrant(grant(2, { access_mode: 'READ_WRITE', status: 'Active', in_force: true, starts_at: '2026-10-30T02:00:00Z', approved_by: SOMEONE, second_approver_id: ME }));
    expect(view).toMatchObject({ id: 'grant-2', accessMode: 'READ_WRITE', status: 'Active', inForce: true, modules: ['CTR', 'DOC'], approvedBy: SOMEONE, secondApproverId: ME, revokedAt: undefined });
    expect(toGrant(grant(3, { status: 'Whatever' }))?.status).toBe('Requested');
    expect(toGrantPage(page([grant(1), { nope: true }], 'c'))).toMatchObject({ nextCursor: 'c' });
  });

  it('counts the consents a grant needs and has, and who may decide or revoke', () => {
    const read = toGrant(grant(1)) as NonNullable<ReturnType<typeof toGrant>>;
    const write = toGrant(grant(2, { access_mode: 'READ_WRITE', approved_by: ME })) as NonNullable<ReturnType<typeof toGrant>>;
    expect([approvalsNeeded(read), approvalsGiven(read), approvalsNeeded(write), approvalsGiven(write)]).toEqual([1, 0, 2, 1]);
    expect(canDecide(read, ME)).toBe(true);
    expect(canDecide(write, ME)).toBe(false);
    expect(canDecide(write, SOMEONE)).toBe(true);
    expect(canDecide({ ...read, status: 'Active' }, ME)).toBe(false);
    expect(canRevoke({ ...read, status: 'Active' })).toBe(true);
    expect(canRevoke({ ...read, status: 'Expired' })).toBe(false);
  });

  it('names the problem by the code the server answered', () => {
    const problem = (code: string, detail?: string) => describeProblem(new ApiError({ status: 409, code, correlationId: 'c', detail }));
    expect(problem('SELF_APPROVAL_DENIED').reason).toBe('selfApproval');
    expect(problem('SUPPORT_GRANT_INVALID').reason).toBe('grantState');
    expect(problem('TICKET_NOT_FOUND').reason).toBe('ticket');
    expect(problem('VERSION_CONFLICT').reason).toBe('conflict');
    expect(problem('VALIDATION_FAILED', 'duration_minutes')).toEqual({ reason: 'invalid', field: 'duration_minutes' });
    expect(problem('SOMETHING_ELSE').reason).toBe('general');
    expect(describeProblem(new Error('x')).reason).toBe('general');
  });
});
