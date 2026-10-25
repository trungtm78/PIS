import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { harness } from '../sas/test-support';
import ExtensionScreen from './ExtensionScreen';
import { PUBLISHED_ID, plan, planLine, totalsOfLines } from './plan-test-support';
import type { Harness } from './plan-test-support';
import { ME, OTHER, mount, routeOf } from './test-support';

const ROUTE = routeOf('CAP-20', 'FR-CAP-20');
const PLANNER = ['capital.read', 'plan_version.read', 'allocation_line.read', 'project.read', 'capital.extension.request'];
const APPROVER = ['capital.read', 'capital.extension.approve'];
const BOTH = [...PLANNER, 'capital.extension.approve'];
const READER = ['capital.read'];
const BILLION = 1_000_000_000;
const money = (billions: number): string => String(billions * BILLION);
const DOCUMENT = '00000000-0000-4000-8000-0000000000d1';
const LINE = planLine(1, { capital_plan_id: PUBLISHED_ID, plan_status: 'PUBLISHED', amount_vnd: money(3) });
const LINE_ID = LINE.id as string;
const problem = (code: string, status = 422, detail?: string, extensions: Record<string, unknown> = {}) => new ApiError({ status, code, correlationId: 'c', ...(detail === undefined ? {} : { detail }), extensions });

const extension = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-00000000e00${n}`,
  allocation_line_id: LINE_ID,
  project_id: LINE.project ? (LINE.project as { id: string }).id : '',
  from_plan_year: 2025,
  extended_to: '2026-01-31',
  amount_vnd: money(1),
  reason_code: 'GPMB_CHAM',
  justification: 'Mặt bằng chưa bàn giao do vướng hộ dân',
  status: 'REQUESTED',
  requested_by: OTHER,
  version: 1,
  ...overrides,
});

interface State {
  extensions: Array<Record<string, unknown>>;
  availability: Record<string, unknown>;
  failing: Map<string, unknown>;
}

const state = (overrides: Partial<State> = {}): State => ({
  extensions: [extension(1), extension(2, { requested_by: ME, status: 'REQUESTED', amount_vnd: money(1) }), extension(3, { status: 'APPLIED', decided_by: OTHER, decision_reason: 'Đúng căn cứ', version: 2, approving_document_id: DOCUMENT })],
  availability: { allocation_line_id: LINE_ID, allocated_vnd: money(3), reserved_vnd: '0', committed_vnd: '500000000', disbursed_vnd: '500000000', available_vnd: money(2) },
  failing: new Map(),
  ...overrides,
});

function client(current: State, command: (operation: string, input: unknown) => unknown = () => ({})): Harness {
  const plans = [
    plan(PUBLISHED_ID, { plan_code: 'CP-2025', plan_year: 2025, period_from_year: 2025, period_to_year: 2025, status: 'PUBLISHED', version: 9 }),
    plan('00000000-0000-4000-8000-000000000a02', { plan_code: 'CP-DRAFT', status: 'DRAFT' }),
    plan('00000000-0000-4000-8000-000000000a03', { plan_code: 'TH-2026', plan_kind: 'MEDIUM_TERM', plan_year: null, status: 'PUBLISHED' }),
  ];
  const carried = planLine(2, { capital_plan_id: PUBLISHED_ID, bucket: 'CARRYOVER', is_extended: true, extended_to: '2026-12-31', source_year: 2024 });
  const h = harness((operation, input) => {
    if (current.failing.has(operation)) return current.failing.get(operation) as Error;
    if (operation === 'listCapitalPlanLines') {
      const lines = [LINE, carried];
      return { plan: plans[0], items: lines, totals: totalsOfLines(lines), next_cursor: null, as_of: '2026-10-25T00:00:00Z' };
    }
    if (operation === 'getCapitalAvailability') return current.availability;
    return new Error(`unexpected read ${operation} ${JSON.stringify(input)}`);
  }, command);
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn((operation: string) => {
    if (current.failing.has(operation)) return Promise.reject(current.failing.get(operation));
    switch (operation) {
      case 'listAllocationExtensions':
        return Promise.resolve(current.extensions);
      case 'get_resources_plan_version':
        return Promise.resolve(plans);
      case 'get_resources_project':
        return Promise.resolve([{ id: (LINE.project as { id: string }).id, code: 'DA-01', name: 'Đường vành đai 3', status: 'BUDGETED' }]);
      default:
        return Promise.reject(new Error(`unexpected readAll ${operation}`));
    }
  });
  return h;
}

const open = (permissions: readonly string[] | undefined, current: State = state(), command?: (operation: string, input: unknown) => unknown, options: { mode?: 'FULL' | 'READ_ONLY' } = {}) => {
  const h = client(current, command);
  mount(<ExtensionScreen route={ROUTE} />, h, { permissions, ...options });
  return h;
};
const form = () => screen.getByRole('form', { name: vi_['cap.extension.form.aria'] });
const rowOf = async (n: number): Promise<HTMLElement> => {
  await screen.findByRole('table', { name: vi_['cap.extension.list.title'] });
  return document.querySelector(`tr[data-extension-id="00000000-0000-4000-8000-00000000e00${n}"]`) as HTMLElement;
};

/** Picks the plan and the line of the form: the figures of the line are read once it is chosen. */
async function pickLine(): Promise<void> {
  const planSelect = await screen.findByLabelText(vi_['cap.extension.field.plan']);
  await waitFor(() => expect(within(planSelect).getAllByRole('option').length).toBeGreaterThan(1));
  fireEvent.change(planSelect, { target: { value: PUBLISHED_ID } });
  const lineSelect = await screen.findByLabelText(vi_['cap.extension.field.line']);
  await waitFor(() => expect(within(lineSelect).getAllByRole('option').length).toBeGreaterThan(1));
  fireEvent.change(lineSelect, { target: { value: LINE_ID } });
  await screen.findByTestId('figures');
  await waitFor(() => expect(screen.getByTestId('figures').getAttribute('data-undisbursed')).not.toBe(''));
}

afterEach(cleanup);

describe('UI-CAP-20 the extension of the disbursement of capital (ST-CAP-007)', () => {
  it('lists the requests with the project, the years, the amount, the last day, the reason, the state and who asked and decided', async () => {
    open(BOTH);
    const waiting = await rowOf(1);
    expect(within(waiting).getByText('DA-01 · Đường vành đai 3')).toBeTruthy();
    expect(within(waiting).getByText(vi_['cap.extension.years.text'].replace('{from}', '2025').replace('{to}', '2026'))).toBeTruthy();
    expect(within(waiting).getByText(vi_['cap.extension.reason.gpmb'])).toBeTruthy();
    expect(within(waiting).getByText(vi_['cap.extension.status.requested'])).toBeTruthy();
    expect(within(waiting).getByText(vi_['cap.extension.people.requested'].replace('{person}', OTHER.slice(0, 8)))).toBeTruthy();
    const applied = await rowOf(3);
    expect(within(applied).getByText(vi_['cap.extension.status.applied'])).toBeTruthy();
    expect(within(applied).getByText(vi_['cap.extension.people.decided'].replace('{person}', OTHER.slice(0, 8)))).toBeTruthy();
    expect(within(applied).getByText('Đúng căn cứ')).toBeTruthy();
    expect(within(applied).queryByRole('button')).toBeNull();
  });

  it('offers a request of someone else to approve or reject, and the own request to nobody to decide', async () => {
    open(BOTH);
    const others = await rowOf(1);
    expect(within(others).getByRole('button', { name: vi_['cap.extension.approve.action'] })).toBeTruthy();
    expect(within(others).getByRole('button', { name: vi_['cap.extension.reject.action'] })).toBeTruthy();
    const own = await rowOf(2);
    expect(within(own).queryByRole('button')).toBeNull();
    expect(within(own).getByText(vi_['cap.extension.self.notice'])).toBeTruthy();
    expect(within(own).getByText(vi_['cap.extension.people.requested'].replace('{person}', vi_['cap.extension.people.you']))).toBeTruthy();
  });

  it('shows the figures of the chosen line and what is left to carry over, the other open requests taken off', async () => {
    open(PLANNER);
    await pickLine();
    const figures = screen.getByTestId('figures');
    // 3 billion allocated, 0.5 + 0.5 billion used, and the two open requests of 1 billion each: 0.
    expect(figures.getAttribute('data-undisbursed')).toBe('0');
    expect(within(figures).getByText('2025')).toBeTruthy();
    expect(within(figures).getByText((3 * BILLION).toLocaleString('vi'))).toBeTruthy();
  });

  it('keeps out of the choice a plan that is not published or annual and a line that is already carried over', async () => {
    open(PLANNER);
    const planSelect = await screen.findByLabelText(vi_['cap.extension.field.plan']);
    await waitFor(() => expect(within(planSelect).getAllByRole('option')).toHaveLength(2));
    expect(within(planSelect).queryByText(/CP-DRAFT/)).toBeNull();
    expect(within(planSelect).queryByText(/TH-2026/)).toBeNull();
    fireEvent.change(planSelect, { target: { value: PUBLISHED_ID } });
    const lineSelect = await screen.findByLabelText(vi_['cap.extension.field.line']);
    await waitFor(() => expect(within(lineSelect).getAllByRole('option')).toHaveLength(2));
  });

  it('asks for the extension: checks the form first, then sends the amount, the last day and the reason against the line (UAT-PLAN-61, AC-ST-CAP-007-3)', async () => {
    const h = open(PLANNER, state({ extensions: [] }));
    await pickLine();
    const send = within(form()).getByRole('button', { name: vi_['cap.extension.request.action'] });
    fireEvent.click(send);
    expect(h.command).not.toHaveBeenCalled();
    expect(within(form()).getAllByRole('alert').length).toBeGreaterThanOrEqual(3);

    // More than what is left is refused in the browser, with the figure.
    fireEvent.change(screen.getByLabelText(vi_['cap.extension.field.amount']), { target: { value: String(3 * BILLION) } });
    fireEvent.change(screen.getByLabelText(vi_['cap.extension.field.until']), { target: { value: '2026-03-31' } });
    fireEvent.change(screen.getByLabelText(vi_['cap.extension.field.reason']), { target: { value: 'GPMB_CHAM' } });
    fireEvent.click(send);
    expect(within(form()).getByText(vi_['cap.extension.fieldError.exceeds'].replace('{undisbursed}', (2 * BILLION).toLocaleString('vi')))).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(vi_['cap.extension.field.amount']), { target: { value: String(2 * BILLION) } });
    expect((await screen.findByTestId('preview')).textContent).toContain('2026');
    fireEvent.click(send);
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command).toHaveBeenCalledWith('requestAllocationExtension', expect.objectContaining({ path: { id: LINE_ID }, body: { amount_vnd: String(2 * BILLION), extended_to: '2026-03-31', reason_code: 'GPMB_CHAM' } }));
    expect(await screen.findByText(vi_['cap.extension.done.requested'])).toBeTruthy();
  });

  it('checks the last day against the year after the plan year, and asks for words with another reason', async () => {
    const h = open(PLANNER, state({ extensions: [], availability: { allocated_vnd: money(3), committed_vnd: '0', disbursed_vnd: '0' } }));
    await pickLine();
    const send = within(form()).getByRole('button', { name: vi_['cap.extension.request.action'] });
    fireEvent.change(screen.getByLabelText(vi_['cap.extension.field.amount']), { target: { value: '1000' } });
    fireEvent.change(screen.getByLabelText(vi_['cap.extension.field.until']), { target: { value: '2025-12-31' } });
    fireEvent.change(screen.getByLabelText(vi_['cap.extension.field.reason']), { target: { value: 'KHAC' } });
    fireEvent.click(send);
    expect(within(form()).getByText(vi_['cap.extension.fieldError.tooEarly'].replace('{from}', new Date('2026-01-01T00:00:00Z').toLocaleDateString('vi', { timeZone: 'UTC' })))).toBeTruthy();
    expect(within(form()).getByText(vi_['cap.extension.fieldError.justificationRequired'])).toBeTruthy();
    fireEvent.change(screen.getByLabelText(vi_['cap.extension.field.until']), { target: { value: '2027-01-01' } });
    fireEvent.click(send);
    expect(within(form()).getByText(vi_['cap.extension.fieldError.tooLate'].replace('{to}', new Date('2026-12-31T00:00:00Z').toLocaleDateString('vi', { timeZone: 'UTC' })))).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('approves with the document that allows it and a reason, against the version that was read, and says the line of the next year was made (AC-ST-CAP-007-1)', async () => {
    const h = open(BOTH);
    fireEvent.click(within(await rowOf(1)).getByRole('button', { name: vi_['cap.extension.approve.action'] }));
    const decision = await screen.findByRole('form', { name: vi_['cap.extension.decision.aria'] });
    fireEvent.click(within(decision).getByRole('button', { name: vi_['cap.extension.decision.confirm.approve'] }));
    expect(within(decision).getByText(vi_['cap.extension.fieldError.required'])).toBeTruthy();
    expect(within(decision).getByText(vi_['cap.extension.fieldError.reasonLength'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(decision).getByLabelText(vi_['cap.extension.field.document']), { target: { value: 'not-an-id' } });
    fireEvent.click(within(decision).getByRole('button', { name: vi_['cap.extension.decision.confirm.approve'] }));
    expect(within(decision).getByText(vi_['cap.extension.fieldError.invalidId'])).toBeTruthy();
    fireEvent.change(within(decision).getByLabelText(vi_['cap.extension.field.document']), { target: { value: DOCUMENT.toUpperCase() } });
    fireEvent.change(within(decision).getByLabelText(vi_['cap.extension.field.decisionReason']), { target: { value: 'Đúng với quyết định kéo dài' } });
    fireEvent.click(within(decision).getByRole('button', { name: vi_['cap.extension.decision.confirm.approve'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command).toHaveBeenCalledWith(
      'decideAllocationExtension',
      expect.objectContaining({ path: { id: '00000000-0000-4000-8000-00000000e001' }, ifMatchVersion: 1, body: { decision: 'approve', reason: 'Đúng với quyết định kéo dài', approving_document_id: DOCUMENT } }),
    );
    expect(await screen.findByText(vi_['cap.extension.done.applied'])).toBeTruthy();
    expect(screen.queryByRole('form', { name: vi_['cap.extension.decision.aria'] })).toBeNull();
  });

  it('rejects with a reason and no document, and lets the person change their mind before confirming', async () => {
    const h = open(BOTH);
    fireEvent.click(within(await rowOf(1)).getByRole('button', { name: vi_['cap.extension.reject.action'] }));
    let decision = await screen.findByRole('form', { name: vi_['cap.extension.decision.aria'] });
    expect(within(decision).queryByLabelText(vi_['cap.extension.field.document'])).toBeNull();
    fireEvent.click(within(decision).getByRole('button', { name: vi_['cap.extension.decision.cancel.action'] }));
    expect(screen.queryByRole('form', { name: vi_['cap.extension.decision.aria'] })).toBeNull();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.click(within(await rowOf(1)).getByRole('button', { name: vi_['cap.extension.reject.action'] }));
    decision = await screen.findByRole('form', { name: vi_['cap.extension.decision.aria'] });
    fireEvent.change(within(decision).getByLabelText(vi_['cap.extension.field.decisionReason']), { target: { value: 'Chưa đủ căn cứ' } });
    fireEvent.click(within(decision).getByRole('button', { name: vi_['cap.extension.decision.confirm.reject'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command).toHaveBeenCalledWith('decideAllocationExtension', expect.objectContaining({ ifMatchVersion: 1, body: { decision: 'reject', reason: 'Chưa đủ căn cứ' } }));
    expect(await screen.findByText(vi_['cap.extension.done.rejected'])).toBeTruthy();
  });

  it('tells the person when the server refuses, in the words of the refusal', async () => {
    const cases: Array<[Error, string]> = [
      [problem('SELF_APPROVAL_DENIED', 403), vi_['cap.extension.problem.selfApproval']],
      [problem('EXTENSION_DOCUMENT_REQUIRED', 422, 'approving_document_id'), vi_['cap.extension.problem.documentRequired']],
      [problem('VERSION_CONFLICT', 409), vi_['cap.extension.problem.conflict']],
      [problem('STAGE_TRANSITION_DENIED', 409), vi_['cap.extension.problem.stageDenied']],
      [problem('FISCAL_YEAR_LOCKED', 409, 'plan_year'), vi_['cap.extension.problem.yearLocked']],
      [problem('APPROPRIATION_DUPLICATE', 409), vi_['cap.extension.problem.duplicate']],
      [problem('AMOUNT_EXCEEDS_UNDISBURSED', 422, 'amount_vnd', { undisbursed_vnd: money(1) }), vi_['cap.extension.problem.amountExceedsLeft'].replace('{undisbursed}', BILLION.toLocaleString('vi'))],
    ];
    for (const [error, message] of cases) {
      const h = open(BOTH, state(), () => error);
      fireEvent.click(within(await rowOf(1)).getByRole('button', { name: vi_['cap.extension.approve.action'] }));
      const decision = await screen.findByRole('form', { name: vi_['cap.extension.decision.aria'] });
      fireEvent.change(within(decision).getByLabelText(vi_['cap.extension.field.document']), { target: { value: DOCUMENT } });
      fireEvent.change(within(decision).getByLabelText(vi_['cap.extension.field.decisionReason']), { target: { value: 'Đúng với quyết định' } });
      fireEvent.click(within(decision).getByRole('button', { name: vi_['cap.extension.decision.confirm.approve'] }));
      expect(await screen.findByText(message)).toBeTruthy();
      expect(h.command).toHaveBeenCalledTimes(1);
      // A refused decision drops the form: the person looks at the list as it is now.
      expect(screen.queryByRole('form', { name: vi_['cap.extension.decision.aria'] })).toBeNull();
      cleanup();
    }
  });

  it('says why a line cannot be carried over, and where a request was invalid', async () => {
    const cases: Array<[Error, string]> = [
      [problem('EXTENSION_NOT_ALLOWED', 422, 'allocation_line_id', { reason: 'LINE_NOT_IN_FORCE' }), vi_['cap.extension.problem.notAllowed.inForce']],
      [problem('EXTENSION_NOT_ALLOWED', 422, 'allocation_line_id', { reason: 'ALREADY_EXTENDED' }), vi_['cap.extension.problem.notAllowed.extended']],
      [problem('EXTENSION_NOT_ALLOWED', 422, 'allocation_line_id', { reason: 'PLAN_NOT_ANNUAL' }), vi_['cap.extension.problem.notAllowed.annual']],
      [problem('EXTENSION_NOT_ALLOWED', 422, 'allocation_line_id', { reason: 'NO_APPROPRIATION' }), vi_['cap.extension.problem.notAllowed.appropriation']],
      [problem('EXTENSION_NOT_ALLOWED', 422, 'allocation_line_id'), vi_['cap.extension.problem.notAllowed.general']],
      [problem('VALIDATION_FAILED', 422, 'extended_to'), vi_['cap.extension.problem.invalidAt'].replace('{field}', 'extended_to')],
      [problem('VALIDATION_FAILED', 422), vi_['cap.extension.problem.invalid']],
      [problem('SCOPE_DENIED', 403), vi_['cap.extension.problem.denied']],
      [problem('RESOURCE_NOT_FOUND', 404), vi_['cap.extension.problem.notFound']],
      [problem('SESSION_EXPIRED', 401), vi_['cap.extension.problem.session']],
      [problem('INTERNAL_ERROR', 500), vi_['cap.extension.problem.general']],
    ];
    for (const [error, message] of cases) {
      open(PLANNER, state({ extensions: [], availability: { allocated_vnd: money(3), committed_vnd: '0', disbursed_vnd: '0' } }), () => error);
      await pickLine();
      fireEvent.change(screen.getByLabelText(vi_['cap.extension.field.amount']), { target: { value: '1000' } });
      fireEvent.change(screen.getByLabelText(vi_['cap.extension.field.until']), { target: { value: '2026-03-31' } });
      fireEvent.change(screen.getByLabelText(vi_['cap.extension.field.reason']), { target: { value: 'GPMB_CHAM' } });
      fireEvent.click(within(form()).getByRole('button', { name: vi_['cap.extension.request.action'] }));
      expect(await screen.findByText(message)).toBeTruthy();
      cleanup();
    }
  });

  it('shows the list and nothing to ask or decide to a reader, and nothing to do in the frozen mode', async () => {
    open(READER);
    const row = await rowOf(1);
    expect(screen.queryByRole('form', { name: vi_['cap.extension.form.aria'] })).toBeNull();
    expect(screen.getByText(vi_['cap.extension.form.denied'])).toBeTruthy();
    expect(within(row).queryByRole('button')).toBeNull();
    expect(screen.queryByText(vi_['cap.extension.col.actions'])).toBeNull();
    cleanup();
    open(BOTH, state(), undefined, { mode: 'READ_ONLY' });
    const frozen = await rowOf(1);
    expect(screen.queryByRole('form', { name: vi_['cap.extension.form.aria'] })).toBeNull();
    expect(within(frozen).queryByRole('button')).toBeNull();
  });

  it('shows the approver the list and the decisions but no form to ask', async () => {
    open(APPROVER);
    const row = await rowOf(1);
    expect(screen.queryByRole('form', { name: vi_['cap.extension.form.aria'] })).toBeNull();
    expect(within(row).getByRole('button', { name: vi_['cap.extension.approve.action'] })).toBeTruthy();
  });

  it('says so when no request was made, and shows the loading, signed-out, denied, offline and error states of the list', async () => {
    open(READER, state({ extensions: [] }));
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(await screen.findByText(vi_['cap.extension.list.empty'])).toBeTruthy();
    cleanup();
    const failing = [
      [401, 'SESSION_EXPIRED', 'states.signedOut.title'],
      [403, 'SCOPE_DENIED', 'states.denied.title'],
      [0, NETWORK_ERROR_CODE, 'states.offline.title'],
      [500, 'INTERNAL_ERROR', 'states.error.title'],
    ] as const;
    for (const [status, code, key] of failing) {
      open(READER, state({ failing: new Map([['listAllocationExtensions', new ApiError({ status, code, correlationId: 'c' })]]) }));
      expect(await screen.findByText(vi_[key as keyof typeof vi_])).toBeTruthy();
      cleanup();
    }
  });

  it('retries the list from the error state', async () => {
    let reads = 0;
    const current = state();
    const h = client(current);
    (h.client as unknown as { readAll: unknown }).readAll = vi.fn((operation: string) => {
      if (operation !== 'listAllocationExtensions') return Promise.resolve([]);
      reads += 1;
      return reads === 1 ? Promise.reject(new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' })) : Promise.resolve(current.extensions);
    });
    mount(<ExtensionScreen route={ROUTE} />, h, { permissions: READER });
    await screen.findByText(vi_['states.error.title']);
    fireEvent.click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
    expect(await rowOf(1)).toBeTruthy();
  });
});
