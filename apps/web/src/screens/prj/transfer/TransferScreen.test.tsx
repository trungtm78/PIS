import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { UNIT_DEPARTMENT, UNIT_PROVINCE, client, line, mount, routeOf, world } from '../test-support';
import type { Harness } from '../test-support';
import TransferScreen from './TransferScreen';
import { canDecide, currentUnitId, describeTransfer, requestBody, targetUnitId, toImpact, toTransferPage, validateDecision, validateRequest, vietnamToday } from './model';

const ROUTE = routeOf('PRJ-20', 'FR-PRJ-20');
const ME = '00000000-0000-4000-8000-000000000001'; // the member of the session of the test support
const OTHER = '00000000-0000-4000-8000-0000000000c2';
const ASKER = ['project.read', 'project.transfer.request', 'organization_unit.read'];
const ASKER_WITHOUT_UNITS = ['project.read', 'project.transfer.request'];
const DECIDER = ['project.read', 'project.transfer.approve'];
const READER = ['project.read'];
const OK = { operation_id: 'o', status: 'REQUESTED', resource_version: 1, resource_id: 'x' };
const DOCUMENT = '00000000-0000-4000-8000-0000000000d1';

const transfer = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-0000000000e${n}`,
  project: { id: line(1).id, code: line(1).code, name: line(1).name },
  transfer_scope: 'OWNER_UNIT',
  from_unit: { id: UNIT_DEPARTMENT, name: 'Sở Giao thông' },
  to_unit: { id: UNIT_PROVINCE, name: 'Ban QLDA tỉnh' },
  effective_date: '2099-01-01',
  decision_document_id: null,
  reason: 'The province takes over the construction of this bridge',
  status: 'REQUESTED',
  approved_by: null,
  decision_reason: null,
  decided_at: null,
  applied_at: null,
  created_at: '2026-10-24T01:00:00.000000Z',
  created_by: OTHER,
  version: 1,
  ...overrides,
});

const IMPACT = { project_id: line(1).id, transfer_scope: 'OWNER_UNIT', from_unit: { id: UNIT_DEPARTMENT, name: 'Sở Giao thông' }, to_unit: { id: UNIT_PROVINCE, name: 'Ban QLDA tỉnh' }, reports: 12, snapshot_lines: 5, plan_lines: 3, users_gaining: 4, users_losing: 2, members_checked: 40, partial: false, as_of: '2026-10-27' };

afterEach(cleanup);

interface Served {
  pages: Array<Record<string, unknown>>;
  failing?: Error;
  impact?: unknown;
  impactFails?: boolean;
}

function open(served: Served, command: (operation: string, input: unknown) => unknown = () => OK, projects: Array<Record<string, unknown>> = [line(1)]): Harness {
  const h = client(world({ projects }), command);
  const previous = h.read.getMockImplementation();
  let call = 0;
  h.read.mockImplementation((operation: string, input?: unknown) => {
    if (operation === 'listProjectTransfers') {
      if (served.failing !== undefined) return Promise.reject(served.failing);
      const page = served.pages[Math.min(call, served.pages.length - 1)];
      call += 1;
      return Promise.resolve(page);
    }
    if (operation === 'getProjectTransferImpact') return served.impactFails === true ? Promise.reject(new Error('impact failed')) : Promise.resolve(served.impact ?? IMPACT);
    return previous === undefined ? Promise.reject(new Error(`unexpected read ${operation}`)) : previous(operation, input);
  });
  return h;
}

const page = (items: unknown[], next: string | null = null) => ({ items, next_cursor: next, as_of: '2026-10-27' });
const show = (h: Harness, permissions: readonly string[], mode?: 'FULL' | 'READ_ONLY') => mount(<TransferScreen route={ROUTE} />, h, { permissions, ...(mode === undefined ? {} : { mode }), path: '/prj/prj-20' });
const asked = (h: Harness, operation: string) => h.read.mock.calls.filter(([name]) => name === operation).map(([, input]) => input as { path?: Record<string, string>; query?: Record<string, unknown> });
const choose = async (label: string, value: string) => {
  const select = (await screen.findByLabelText(label)) as HTMLSelectElement;
  await waitFor(() => expect(Array.from(select.options).some((option) => option.value === value)).toBe(true));
  fireEvent.change(select, { target: { value } });
};

describe('TransferScreen (PRJ-20): the transfer of a project between units', () => {
  it('UI-PRJ-20: lists the project, the current unit, the receiving unit, what is transferred, the effective day, the basis and the state in words; a reader only reads', async () => {
    const h = open({ pages: [page([transfer(1), transfer(2, { status: 'APPLIED', transfer_scope: 'INVESTOR_UNIT', decision_reason: 'Decision of the people committee' })])] });
    show(h, READER);
    const table = await screen.findByTestId('transfers');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['prj.transfer.page.title']);
    for (const key of ['prj.transfer.col.project', 'prj.transfer.col.current', 'prj.transfer.col.target', 'prj.transfer.col.scope', 'prj.transfer.col.effective', 'prj.transfer.col.basis'] as const) {
      expect(within(table).getByRole('columnheader', { name: vi_[key] })).toBeTruthy();
    }
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]?.textContent).toContain('DA-2026-001 Dự án số 1');
    expect(rows[0]?.textContent).toContain('Sở Giao thông');
    expect(rows[0]?.textContent).toContain('Ban QLDA tỉnh');
    expect(rows[0]?.textContent).toContain(vi_['prj.transfer.scope.owner']);
    expect(rows[0]?.textContent).toContain('2099-01-01');
    expect(rows[0]?.textContent).toContain(vi_['prj.transfer.status.requested']);
    expect(rows[1]?.textContent).toContain(vi_['prj.transfer.scope.investor']);
    expect(rows[1]?.textContent).toContain(vi_['prj.transfer.status.applied']);
    expect(rows[1]?.textContent).toContain(vi_['prj.transfer.decision.note'].replace('{note}', 'Decision of the people committee'));
    expect(screen.queryByRole('form', { name: vi_['prj.transfer.form.title'] })).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['prj.transfer.decide.action'] })).toBeNull();
  });

  describe('asking (AC-ST-PRJ-007-1, AC-ST-PRJ-007-2)', () => {
    it('AC-ST-PRJ-007-2: shows what the transfer would change before it is asked for, with the counts the server reads, and sends the request under the version of the project the screen showed', async () => {
      const h = open({ pages: [page([])] });
      show(h, ASKER);
      const form = await screen.findByRole('form', { name: vi_['prj.transfer.form.title'] });
      expect(within(form).getByText(vi_['prj.transfer.impact.choose'])).toBeTruthy();
      await choose(vi_['prj.transfer.field.project.label'], line(1).id);
      expect(within(form).getByTestId('transfer-current').textContent).toContain('Sở Giao thông');
      await choose(vi_['prj.transfer.field.target.label'], UNIT_PROVINCE);
      const impact = await within(form).findByTestId('impact');
      expect(within(impact).getByTestId('impact-reports').textContent).toBe(vi_['prj.transfer.impact.reports'].replace('{reports}', '12').replace('{snapshots}', '5').replace('{unit}', 'Sở Giao thông'));
      expect(within(impact).getByTestId('impact-plan').textContent).toBe(vi_['prj.transfer.impact.plan'].replace('{lines}', '3').replace('{unit}', 'Ban QLDA tỉnh'));
      expect(within(impact).getByTestId('impact-users').textContent).toBe(vi_['prj.transfer.impact.users'].replace('{gaining}', '4').replace('{losing}', '2'));
      expect(asked(h, 'getProjectTransferImpact').at(-1)).toEqual({ path: { id: line(1).id }, query: { to_unit_id: UNIT_PROVINCE, transfer_scope: 'OWNER_UNIT' } });
      fireEvent.change(within(form).getByLabelText(vi_['prj.transfer.field.effective.label']), { target: { value: '2099-10-01' } });
      fireEvent.change(within(form).getByLabelText(vi_['prj.transfer.field.reason.label']), { target: { value: 'The province takes over the construction of this bridge' } });
      fireEvent.change(within(form).getByLabelText(vi_['prj.transfer.field.document.label']), { target: { value: DOCUMENT } });
      fireEvent.click(within(form).getByRole('button', { name: vi_['prj.transfer.form.submit.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('requestProjectTransfer');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({
        path: { id: line(1).id },
        ifMatchVersion: 1,
        body: { to_unit_id: UNIT_PROVINCE, transfer_scope: 'OWNER_UNIT', effective_date: '2099-10-01', reason: 'The province takes over the construction of this bridge', decision_document_id: DOCUMENT },
      });
      expect((await screen.findByTestId('request-saved')).textContent).toBe(vi_['prj.transfer.form.saved']);
    });

    it('refuses before it sends what is missing, the same unit, a day before today and a document that is not an identifier', async () => {
      const h = open({ pages: [page([])] });
      show(h, ASKER);
      const form = await screen.findByRole('form', { name: vi_['prj.transfer.form.title'] });
      fireEvent.click(within(form).getByRole('button', { name: vi_['prj.transfer.form.submit.action'] }));
      expect((await within(form).findAllByText(vi_['prj.transfer.field.required.error'])).length).toBeGreaterThanOrEqual(4);
      await choose(vi_['prj.transfer.field.project.label'], line(1).id);
      await choose(vi_['prj.transfer.field.target.label'], UNIT_DEPARTMENT);
      fireEvent.change(within(form).getByLabelText(vi_['prj.transfer.field.effective.label']), { target: { value: '2020-01-01' } });
      fireEvent.change(within(form).getByLabelText(vi_['prj.transfer.field.reason.label']), { target: { value: 'The province takes over the construction of this bridge' } });
      fireEvent.change(within(form).getByLabelText(vi_['prj.transfer.field.document.label']), { target: { value: 'not an identifier' } });
      fireEvent.click(within(form).getByRole('button', { name: vi_['prj.transfer.form.submit.action'] }));
      expect(await within(form).findByText(vi_['prj.transfer.field.same.error'])).toBeTruthy();
      expect(within(form).getByText(vi_['prj.transfer.field.past.error'])).toBeTruthy();
      expect(within(form).getByText(vi_['prj.transfer.field.invalid.error'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
      // The impact of a unit that is the unit the project has is not asked for.
      expect(asked(h, 'getProjectTransferImpact')).toHaveLength(0);
    });

    it('offers the investor unit as well: it is the one the project has for that scope, and a project with none has nothing to transfer', async () => {
      const bare = line(3, { investor_unit_id: null, investor_unit_name: null });
      const h = open({ pages: [page([])] }, () => OK, [line(1), bare]);
      show(h, ASKER);
      const form = await screen.findByRole('form', { name: vi_['prj.transfer.form.title'] });
      await choose(vi_['prj.transfer.field.project.label'], line(1).id);
      fireEvent.change(within(form).getByLabelText(vi_['prj.transfer.field.scope.label']), { target: { value: 'INVESTOR_UNIT' } });
      expect(within(form).getByTestId('transfer-current').textContent).toContain('Ban QLDA tỉnh');
      await choose(vi_['prj.transfer.field.target.label'], UNIT_DEPARTMENT);
      await within(form).findByTestId('impact');
      expect(asked(h, 'getProjectTransferImpact').at(-1)?.query).toEqual({ to_unit_id: UNIT_DEPARTMENT, transfer_scope: 'INVESTOR_UNIT' });
      await choose(vi_['prj.transfer.field.project.label'], bare.id);
      expect(within(form).getByTestId('transfer-current').textContent).toContain(vi_['prj.transfer.field.current.none']);
      fireEvent.click(within(form).getByRole('button', { name: vi_['prj.transfer.form.submit.action'] }));
      expect((await within(form).findAllByText(vi_['prj.transfer.field.invalid.error'])).length).toBeGreaterThanOrEqual(1);
      expect(h.command).not.toHaveBeenCalled();
    });

    it('names the receiving unit by its identifier when the caller may not list the units, or the list cannot be loaded, and still shows the impact', async () => {
      const h = open({ pages: [page([])] });
      show(h, ASKER_WITHOUT_UNITS);
      const form = await screen.findByRole('form', { name: vi_['prj.transfer.form.title'] });
      expect(within(form).queryByLabelText(vi_['prj.transfer.field.target.label'])).toBeNull();
      await choose(vi_['prj.transfer.field.project.label'], line(1).id);
      fireEvent.change(within(form).getByLabelText(vi_['prj.transfer.field.targetId.label']), { target: { value: 'not an identifier' } });
      fireEvent.click(within(form).getByRole('button', { name: vi_['prj.transfer.form.submit.action'] }));
      expect(await within(form).findAllByText(vi_['prj.transfer.field.invalid.error'])).not.toHaveLength(0);
      fireEvent.change(within(form).getByLabelText(vi_['prj.transfer.field.targetId.label']), { target: { value: UNIT_PROVINCE } });
      expect(await within(form).findByTestId('impact')).toBeTruthy();
      expect(asked(h, 'getProjectTransferImpact').at(-1)?.query).toEqual({ to_unit_id: UNIT_PROVINCE, transfer_scope: 'OWNER_UNIT' });
      fireEvent.change(within(form).getByLabelText(vi_['prj.transfer.field.effective.label']), { target: { value: '2099-10-01' } });
      fireEvent.change(within(form).getByLabelText(vi_['prj.transfer.field.reason.label']), { target: { value: 'The province takes over the construction of this bridge' } });
      fireEvent.click(within(form).getByRole('button', { name: vi_['prj.transfer.form.submit.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ body: { to_unit_id: UNIT_PROVINCE } });
      cleanup();
      const failing = open({ pages: [page([])] });
      const readAll = (failing.client as unknown as { readAll: ReturnType<typeof vi.fn> }).readAll;
      const base = readAll.getMockImplementation();
      readAll.mockImplementation((operation: string, input?: unknown) => (operation === 'get_resources_organization_unit' ? Promise.reject(new Error('units failed')) : base?.(operation, input)));
      show(failing, ASKER);
      expect((await screen.findByTestId('units-failed')).textContent).toBe(vi_['prj.transfer.field.target.failed']);
    });

    it('says in words when the impact cannot be worked out and when the server refuses the request', async () => {
      const h = open({ pages: [page([])], impactFails: true }, () => new ApiError({ status: 409, code: 'TRANSFER_PENDING_EXISTS', correlationId: 'c' }));
      show(h, ASKER);
      const form = await screen.findByRole('form', { name: vi_['prj.transfer.form.title'] });
      await choose(vi_['prj.transfer.field.project.label'], line(1).id);
      await choose(vi_['prj.transfer.field.target.label'], UNIT_PROVINCE);
      expect((await within(form).findByTestId('impact-failed')).textContent).toBe(vi_['prj.transfer.impact.failed']);
      fireEvent.change(within(form).getByLabelText(vi_['prj.transfer.field.effective.label']), { target: { value: '2099-10-01' } });
      fireEvent.change(within(form).getByLabelText(vi_['prj.transfer.field.reason.label']), { target: { value: 'The province takes over the construction of this bridge' } });
      fireEvent.click(within(form).getByRole('button', { name: vi_['prj.transfer.form.submit.action'] }));
      expect((await within(form).findByTestId('request-refusal')).textContent).toBe(vi_['prj.transfer.problem.pendingExists']);
    });
  });

  describe('deciding', () => {
    it('approves a request under the version the list showed, with a reason; the reason is needed', async () => {
      const h = open({ pages: [page([transfer(1, { version: 3 })])] }, () => ({ ...OK, status: 'APPROVED' }));
      show(h, DECIDER);
      fireEvent.click(await screen.findByRole('button', { name: vi_['prj.transfer.decide.action'] }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByTestId('decide-summary').textContent).toBe(vi_['prj.transfer.decide.summary'].replace('{from}', 'Sở Giao thông').replace('{to}', 'Ban QLDA tỉnh').replace('{date}', '2099-01-01'));
      fireEvent.click(within(dialog).getByRole('button', { name: vi_['prj.transfer.decide.submit.action'] }));
      expect(await within(dialog).findByText(vi_['prj.transfer.field.required.error'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
      fireEvent.change(within(dialog).getByLabelText(vi_['prj.transfer.decide.reason.label']), { target: { value: 'Decision of the people committee' } });
      fireEvent.click(within(dialog).getByRole('button', { name: vi_['prj.transfer.decide.submit.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('decideProjectTransfer');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: transfer(1).id }, ifMatchVersion: 3, body: { decision: 'approve', reason: 'Decision of the people committee' } });
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('rejects or returns a request, offers the decision only on a request that waits and was not asked by the member, and tells a refusal in words', async () => {
      const h = open({ pages: [page([transfer(1), transfer(2, { created_by: ME }), transfer(3, { status: 'APPLIED' })])] }, () => new ApiError({ status: 403, code: 'SELF_APPROVAL_DENIED', correlationId: 'c' }));
      show(h, DECIDER);
      const buttons = await screen.findAllByRole('button', { name: vi_['prj.transfer.decide.action'] });
      expect(buttons).toHaveLength(1);
      fireEvent.click(buttons[0] as HTMLElement);
      const dialog = await screen.findByRole('dialog');
      fireEvent.click(within(dialog).getByRole('radio', { name: vi_['prj.transfer.decide.return'] }));
      fireEvent.change(within(dialog).getByLabelText(vi_['prj.transfer.decide.reason.label']), { target: { value: 'Attach the decision of the committee' } });
      fireEvent.click(within(dialog).getByRole('button', { name: vi_['prj.transfer.decide.submit.action'] }));
      expect((await within(dialog).findByTestId('decide-refusal')).textContent).toBe(vi_['prj.transfer.problem.selfApproval']);
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ body: { decision: 'return' } });
    });
  });

  it('narrows the list by status and loads the next page by cursor', async () => {
    const h = open({ pages: [page([transfer(1)], 'next'), page([transfer(2)])] });
    show(h, READER);
    await screen.findByTestId('transfers');
    fireEvent.click(await screen.findByRole('button', { name: vi_['prj.transfer.more.action'] }));
    await waitFor(() => expect(screen.getByTestId('transfers').querySelectorAll('tbody tr')).toHaveLength(2));
    expect(asked(h, 'listProjectTransfers').map((input) => input.query)).toEqual([{ limit: 25 }, { limit: 25, cursor: 'next' }]);
    fireEvent.change(screen.getByLabelText(vi_['prj.transfer.filter.status.label']), { target: { value: 'APPROVED' } });
    await waitFor(() => expect(asked(h, 'listProjectTransfers').at(-1)?.query).toEqual({ limit: 25, status: 'APPROVED' }));
  });

  it('is in each state of a screen: loading, empty, denied, signed out, offline and error', async () => {
    show(open({ pages: [page([])] }), READER);
    expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
    for (const [error, title] of [
      [new ApiError({ status: 403, code: 'FORBIDDEN', correlationId: 'c' }), vi_['states.denied.title']],
      [new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' }), vi_['states.signedOut.title']],
      [new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), vi_['states.offline.title']],
      [new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' }), vi_['states.error.title']],
    ] as const) {
      cleanup();
      show(open({ pages: [page([])], failing: error }), READER);
      expect(await screen.findByText(title)).toBeTruthy();
    }
  });
});

describe('the transfer model', () => {
  it('reads a page and the impact and drops what is not whole, and names the refusals of the server', () => {
    expect(toTransferPage(undefined)).toEqual({ items: [], nextCursor: undefined });
    const read = toTransferPage({ items: [transfer(1), { id: 'x' }, transfer(2, { status: 'NOPE' }), transfer(3, { transfer_scope: 'ALL' })], next_cursor: 'c' });
    expect(read.items.map((item) => item.id)).toEqual([transfer(1).id]);
    expect(read.nextCursor).toBe('c');
    expect(toImpact(IMPACT)).toMatchObject({ reports: 12, snapshotLines: 5, planLines: 3, usersGaining: 4, usersLosing: 2, partial: false, fromUnitName: 'Sở Giao thông' });
    expect(toImpact({ reports: 'many' })).toBeUndefined();
    const codes = ['TRANSFER_PENDING_EXISTS', 'SELF_APPROVAL_DENIED', 'VERSION_CONFLICT', 'STAGE_TRANSITION_DENIED', 'SCOPE_DENIED', 'PROJECT_STAGE_INVALID', 'DECISION_REQUIRED', 'VALIDATION_FAILED', 'RESOURCE_NOT_FOUND', 'OTHER'];
    expect(codes.map((code) => describeTransfer(new ApiError({ status: 409, code, correlationId: 'c' })))).toEqual(['pendingExists', 'selfApproval', 'versionConflict', 'stageDenied', 'scopeDenied', 'projectClosed', 'documentInvalid', 'validation', 'notFound', 'general']);
    expect(describeTransfer(new Error('x'))).toBe('general');
  });

  it('judges the forms and builds what the server reads', () => {
    const today = '2026-10-27';
    const U1 = '00000000-0000-4000-8000-0000000000a1';
    const U2 = '00000000-0000-4000-8000-0000000000a2';
    const blank = { projectId: '', scope: 'OWNER_UNIT' as const, toUnitId: '', toUnitInput: '', effectiveDate: '', reason: '', documentId: '' };
    expect(validateRequest(blank, today, null)).toEqual({ projectId: 'required', toUnitId: 'required', effectiveDate: 'required', reason: 'required' });
    expect(validateRequest({ ...blank, projectId: 'p', toUnitId: U1, effectiveDate: '2026-10-26', reason: 'short', documentId: 'x' }, today, U1)).toEqual({ toUnitId: 'same', effectiveDate: 'past', reason: 'invalid', documentId: 'invalid' });
    expect(validateRequest({ ...blank, projectId: 'p', toUnitId: U1, effectiveDate: '2026-02-30', reason: 'A reason that is long enough' }, today, U2)).toEqual({ effectiveDate: 'invalid' });
    expect(validateRequest({ ...blank, projectId: 'p', toUnitId: U1, effectiveDate: today, reason: 'A reason that is long enough' }, today, U2)).toEqual({});
    // A unit named by its identifier takes the place of the choice, and must be an identifier.
    expect(validateRequest({ ...blank, projectId: 'p', toUnitId: U1, toUnitInput: U2, effectiveDate: today, reason: 'A reason that is long enough' }, today, U1)).toEqual({});
    expect(validateRequest({ ...blank, projectId: 'p', toUnitInput: 'a unit', effectiveDate: today, reason: 'A reason that is long enough' }, today, U1)).toEqual({ toUnitId: 'invalid' });
    expect(targetUnitId({ toUnitId: U1, toUnitInput: ` ${U2} ` })).toBe(U2);
    expect(validateRequest({ ...blank, projectId: 'p', toUnitId: U1, effectiveDate: today, reason: 'A reason that is long enough' }, today, null)).toEqual({ projectId: 'invalid' });
    expect(requestBody({ projectId: 'p', scope: 'INVESTOR_UNIT', toUnitId: U1, toUnitInput: '', effectiveDate: '2026-11-01', reason: ' A reason that is long enough ', documentId: '' })).toEqual({ to_unit_id: U1, transfer_scope: 'INVESTOR_UNIT', effective_date: '2026-11-01', reason: 'A reason that is long enough' });
    expect([validateDecision(''), validateDecision('four'), validateDecision('five5'), validateDecision('x'.repeat(2001))]).toEqual(['required', 'invalid', undefined, 'invalid']);
    expect(currentUnitId({ ownerUnitId: 'o', investorUnitId: 'i' }, 'OWNER_UNIT')).toBe('o');
    expect(currentUnitId({ ownerUnitId: 'o', investorUnitId: null }, 'INVESTOR_UNIT')).toBeNull();
    expect([canDecide({ status: 'REQUESTED', createdBy: OTHER }, ME), canDecide({ status: 'REQUESTED', createdBy: ME }, ME), canDecide({ status: 'APPROVED', createdBy: OTHER }, ME)]).toEqual([true, false, false]);
    expect(vietnamToday(new Date('2026-10-27T18:00:00Z'))).toBe('2026-10-28');
  });
});
