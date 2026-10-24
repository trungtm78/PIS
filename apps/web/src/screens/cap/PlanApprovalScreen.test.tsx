import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import PlanApprovalScreen from './PlanApprovalScreen';
import { ANNUAL_ID, BILLION, PUBLISHED_ID, mount, planClient, planLine, planWorld, plan, routeOf } from './plan-test-support';
import type { PlanWorld } from './plan-test-support';

const ROUTE = routeOf('CAP-10', 'FR-CAP-10');
const SUBMITTER = ['capital.read', 'plan_version.read', 'capital.plan.submit'];
const APPROVER = ['capital.read', 'plan_version.read', 'capital.plan.approve'];
const PUBLISHER = ['capital.read', 'plan_version.read', 'plan.publish'];
const READER = ['capital.read', 'plan_version.read'];
const DOCUMENT = '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';
const OTHER_PROJECT = { id: '00000000-0000-4000-8000-000000000099', code: 'DA-09', name: 'Cầu mới' };
const vnd = (billions: number): string => String(billions * BILLION);
const problem = (code: string, status = 422, extensions: Record<string, unknown> = {}, detail?: string) => new ApiError({ status, code, correlationId: 'c', detail, extensions });
const answer = { operation_id: 'o', status: 'IN_REVIEW', resource_version: 6, resource_id: ANNUAL_ID };

afterEach(cleanup);

/** The revision in work (ANNUAL_ID) replaces the published plan PUBLISHED_ID: line 1 shrinks below what is spent, line 2 is dropped, one line is new. */
function world(status: string, overrides: Record<string, unknown> = {}): PlanWorld {
  const base = planWorld();
  return {
    ...base,
    plans: [plan(ANNUAL_ID, { status, supersedes_id: PUBLISHED_ID, version: 4, revision: 2, ...overrides }), plan(PUBLISHED_ID, { status: 'PUBLISHED', revision: 1, decision_document: { id: DOCUMENT, symbol: '12/QD-UBND', issued_on: '2025-01-10' } })],
    lines: {
      [ANNUAL_ID]: [planLine(1, { amount_vnd: String(8.5 * BILLION) }), planLine(4, { project: OTHER_PROJECT, amount_vnd: vnd(2) })],
      [PUBLISHED_ID]: [
        planLine(1, { capital_plan_id: PUBLISHED_ID, plan_status: 'PUBLISHED', amount_vnd: vnd(10), committed_vnd: vnd(6), disbursed_vnd: vnd(3), reserved_vnd: '0' }),
        planLine(2, { capital_plan_id: PUBLISHED_ID, plan_status: 'PUBLISHED', amount_vnd: vnd(1), committed_vnd: '0', disbursed_vnd: '0', reserved_vnd: '0' }),
      ],
    },
  };
}

const open = (state: PlanWorld, permissions: readonly string[], command?: (operation: string, input: unknown) => unknown, options: { mode?: 'READ_ONLY'; path?: string } = {}) => {
  const h = planClient(state, command);
  mount(<PlanApprovalScreen route={ROUTE} />, h, { permissions, path: options.path ?? '/', ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return h;
};
const ready = () => waitFor(() => expect(screen.getByTestId('state')).toBeTruthy());
const rowOf = (code: string): HTMLElement => Array.from(document.querySelectorAll<HTMLElement>('tbody tr')).find((row) => row.textContent?.includes(code)) as HTMLElement;

describe('PlanApprovalScreen (CAP-10): the approval of a capital plan revision', () => {
  it('opens on the revision that waits for a decision and shows its impact against the revision in force, line by line (UI-CAP-10, AC-ST-CAP-003-2)', async () => {
    open(world('IN_REVIEW'), READER);
    await ready();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['cap.approval.page.title']);
    expect(screen.getByTestId('state').getAttribute('data-status')).toBe('IN_REVIEW');
    expect(screen.getByTestId('plan-header').getAttribute('data-plan-id')).toBe(ANNUAL_ID);
    await waitFor(() => expect(screen.getByTestId('impact')).toBeTruthy());
    expect(screen.getByTestId('impact').textContent).toContain('CP-2026 phiên bản 1');
    // DA-01 goes from 10,000 to 8,500 million with 9,000 spent; DA-02 is dropped; DA-09 is new.
    expect(rowOf('DA-01').getAttribute('data-below')).toBe('true');
    expect(rowOf('DA-01').getAttribute('data-kind')).toBe('CHANGED');
    expect(within(rowOf('DA-01')).getByTestId('delta').textContent).toBe('-1.500');
    expect(rowOf('DA-02').getAttribute('data-kind')).toBe('DROPPED');
    expect(rowOf('DA-09').getAttribute('data-kind')).toBe('NEW');
    expect(screen.getByTestId('total-previous').textContent).toBe('11.000');
    expect(screen.getByTestId('total-next').textContent).toBe('10.500');
    expect(screen.getByTestId('total-delta').textContent).toBe('-500');
    expect(screen.getByTestId('below-count').textContent).toContain('1 dòng');
    // A reader sees no button of any step.
    expect(screen.queryByRole('button', { name: vi_['cap.approval.approve.action'] })).toBeNull();
    expect(screen.getByTestId('actions').textContent).toContain(vi_['cap.approval.denied.notice']);
  });

  it('says that the first revision of a plan is all new capital', async () => {
    const state = world('IN_REVIEW', { supersedes_id: null });
    open(state, READER);
    await waitFor(() => expect(screen.getByTestId('impact')).toBeTruthy());
    expect(screen.getByTestId('impact').textContent).toContain(vi_['cap.approval.impact.noBase.notice']);
    expect(rowOf('DA-01').getAttribute('data-kind')).toBe('NEW');
  });

  it('submits a draft with the version the planner saw (AC-ST-CAP-003-1)', async () => {
    const h = open(world('DRAFT'), SUBMITTER, () => answer);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: vi_['cap.approval.submit.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    const [operation, input] = h.command.mock.calls[0] as [string, { path: { id: string }; ifMatchVersion: number; body: unknown }];
    expect(operation).toBe('submitCapitalPlan');
    expect(input).toMatchObject({ path: { id: ANNUAL_ID }, ifMatchVersion: 4 });
    await waitFor(() => expect(screen.getByText(vi_['cap.approval.done.submit.notice'])).toBeTruthy());
  });

  it('shows the reason a plan was returned for, and a draft with no lines cannot be submitted', async () => {
    const state = world('DRAFT', { decision_reason: 'Lower the line to two billion' });
    state.lines[ANNUAL_ID] = [];
    open(state, SUBMITTER);
    await ready();
    expect(screen.getByTestId('returned').textContent).toContain('Lower the line to two billion');
    expect((screen.getByRole('button', { name: vi_['cap.approval.submit.action'] }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('asks for a reason of at least 5 characters, then approves, returns and rejects with the version it saw (AC-ST-CAP-003-1)', async () => {
    const h = open(world('IN_REVIEW'), APPROVER, () => answer);
    await ready();
    const reason = screen.getByLabelText(vi_['cap.approval.reason.label']) as HTMLTextAreaElement;
    fireEvent.click(screen.getByRole('button', { name: vi_['cap.approval.approve.action'] }));
    expect(screen.getByText(vi_['cap.approval.reason.required.error'])).toBeTruthy();
    fireEvent.change(reason, { target: { value: 'no' } });
    fireEvent.click(screen.getByRole('button', { name: vi_['cap.approval.approve.action'] }));
    expect(screen.getByText(vi_['cap.approval.reason.tooShort.error'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(reason, { target: { value: '  The lines follow the decision  ' } });
    fireEvent.click(screen.getByRole('button', { name: vi_['cap.approval.approve.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]).toEqual(['decideCapitalPlan', expect.objectContaining({ path: { id: ANNUAL_ID }, ifMatchVersion: 4, body: { decision: 'approve', reason: 'The lines follow the decision' } })]);
    await waitFor(() => expect(screen.getByText(vi_['cap.approval.done.approve.notice'])).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: vi_['cap.approval.return.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
    expect((h.command.mock.calls[1] as [string, { body: { decision: string } }])[1].body.decision).toBe('return');
    fireEvent.click(screen.getByRole('button', { name: vi_['cap.approval.reject.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(3));
    expect((h.command.mock.calls[2] as [string, { body: { decision: string } }])[1].body.decision).toBe('reject');
  });

  it('publishes with the decision document and the moment it takes effect; the document must be an identifier (AC-ST-CAP-003-1)', async () => {
    const h = open(world('APPROVED'), PUBLISHER, () => ({ ...answer, status: 'PUBLISHED' }));
    await ready();
    const publish = () => fireEvent.click(screen.getByRole('button', { name: vi_['cap.approval.publish.action'] }));
    publish();
    expect(screen.getByText(vi_['cap.approval.document.required.error'])).toBeTruthy();
    fireEvent.change(screen.getByLabelText(vi_['cap.approval.document.label']), { target: { value: 'QD-12' } });
    publish();
    expect(screen.getByText(vi_['cap.approval.document.invalid.error'])).toBeTruthy();
    fireEvent.change(screen.getByLabelText(vi_['cap.approval.document.label']), { target: { value: DOCUMENT.toUpperCase() } });
    fireEvent.change(screen.getByLabelText(vi_['cap.approval.effective.label']), { target: { value: '2026-07-01T08:00' } });
    publish();
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    const [operation, input] = h.command.mock.calls[0] as [string, { path: { id: string }; ifMatchVersion: number; body: Record<string, string> }];
    expect(operation).toBe('post_plans_id_publish');
    expect(input.path).toEqual({ id: ANNUAL_ID });
    expect(input.ifMatchVersion).toBe(4);
    expect(input.body).toEqual({ decision_document_id: DOCUMENT, effective_at: new Date('2026-07-01T08:00').toISOString() });
    await waitFor(() => expect(screen.getByText(vi_['cap.approval.done.publish.notice'])).toBeTruthy());
    // A revision below the floor warns the publisher before the server refuses it.
    expect(screen.getByText('1 dòng thấp hơn số đã cam kết và giải ngân: việc công bố sẽ bị từ chối.')).toBeTruthy();
  });

  it('publishes when the form is submitted from the keyboard, with the moment the person chose', async () => {
    const h = open(world('APPROVED'), PUBLISHER);
    await ready();
    fireEvent.change(screen.getByLabelText(vi_['cap.approval.document.label']), { target: { value: DOCUMENT } });
    const moment = screen.getByLabelText(vi_['cap.approval.effective.label']) as HTMLInputElement;
    fireEvent.change(moment, { target: { value: '2026-07-01T08:00' } });
    expect(moment.value).toBe('2026-07-01T08:00');
    fireEvent.submit(screen.getByTestId('actions'));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
  });

  it.each([
    ['SELF_APPROVAL_DENIED', 403, 'cap.approvalProblem.selfApproval.error'],
    ['DECISION_REQUIRED', 422, 'cap.approvalProblem.decisionRequired.error'],
    ['PLAN_NOT_APPROVED', 409, 'cap.approvalProblem.notApproved.error'],
    ['FISCAL_YEAR_LOCKED', 409, 'cap.approvalProblem.yearLocked.error'],
    ['VERSION_CONFLICT', 409, 'cap.approvalProblem.versionConflict.error'],
    ['PLAN_CHANGED_SINCE_PROPOSAL', 409, 'cap.approvalProblem.planChanged.error'],
    ['SCOPE_DENIED', 403, 'cap.approvalProblem.denied.error'],
    ['SOMETHING_ELSE', 500, 'cap.approvalProblem.general.error'],
  ])('says what a refused publication means: %s', async (code, status, key) => {
    open(world('APPROVED'), PUBLISHER, () => problem(code, status));
    await ready();
    fireEvent.change(screen.getByLabelText(vi_['cap.approval.document.label']), { target: { value: DOCUMENT } });
    fireEvent.click(screen.getByRole('button', { name: vi_['cap.approval.publish.action'] }));
    await waitFor(() => expect(screen.getByTestId('problem').textContent).toContain((vi_ as Record<string, string>)[key]));
  });

  it('lists the lines a publication was refused for because they are below what is committed (AC-ST-CAP-003-2, UAT-AC225)', async () => {
    const state = world('APPROVED');
    const lineId = (state.lines[ANNUAL_ID]?.[0] as { id: string }).id;
    const lines = [{ line_id: lineId, project_id: 'p', allocated_vnd: String(8.5 * BILLION), committed_vnd: vnd(6), disbursed_vnd: vnd(3), minimum_vnd: vnd(9) }];
    open(state, PUBLISHER, () => problem('REVISED_BELOW_COMMITTED', 422, { lines }));
    await ready();
    fireEvent.change(screen.getByLabelText(vi_['cap.approval.document.label']), { target: { value: DOCUMENT } });
    fireEvent.click(screen.getByRole('button', { name: vi_['cap.approval.publish.action'] }));
    await waitFor(() => expect(screen.getByTestId('below-lines')).toBeTruthy());
    expect(screen.getByTestId('below-lines').textContent).toBe('Dự án DA-01: 8500000000 đồng, thấp hơn mức tối thiểu 9000000000 đồng (đã cam kết 6000000000, đã giải ngân 3000000000).'.replace(/(\d{1,3})(?=(\d{3})+(?!\d))/g, '$1.'));
    expect(screen.getByTestId('problem').textContent).toContain(vi_['cap.approvalProblem.belowCommitted.error']);
  });

  it('says that the national project code is missing and how many projects lack it; and that a plan without lines cannot be submitted', async () => {
    open(world('DRAFT'), SUBMITTER, () => problem('NATIONAL_CODE_REQUIRED', 422, { project_ids: ['a', 'b'] }, 'national_project_code'));
    await ready();
    fireEvent.click(screen.getByRole('button', { name: vi_['cap.approval.submit.action'] }));
    await waitFor(() => expect(screen.getByTestId('problem').textContent).toContain('2 dự án'));
  });

  it('marks a superseded revision, offers no step on it, and lets the person pick another revision', async () => {
    const state = world('SUPERSEDED');
    open(state, APPROVER, undefined, { path: `/?plan=${ANNUAL_ID}` });
    await ready();
    expect(screen.getByTestId('superseded').textContent).toBe(vi_['cap.approval.superseded.label']);
    expect(screen.queryByTestId('actions')).toBeNull();
    fireEvent.change(screen.getByLabelText(vi_['cap.planChooser.label']), { target: { value: PUBLISHED_ID } });
    await waitFor(() => expect(screen.getByTestId('state').getAttribute('data-status')).toBe('PUBLISHED'));
    expect(screen.queryByTestId('superseded')).toBeNull();
  });

  it('turns the steps off for a frozen tenant, and shows the empty state when there is no plan', async () => {
    open(world('IN_REVIEW'), APPROVER, undefined, { mode: 'READ_ONLY' });
    await ready();
    expect(screen.getByTestId('actions').textContent).toContain(vi_['cap.readOnly.frozen.notice']);
    cleanup();
    open({ ...world('IN_REVIEW'), plans: [], lines: {} }, APPROVER);
    await waitFor(() => expect(document.querySelector('[data-state="empty"], [data-testid="state-empty"]') ?? screen.queryByRole('status')).toBeTruthy());
    expect(screen.queryByTestId('state')).toBeNull();
  });

  it('shows a draft the planner may not submit as read only', async () => {
    open(world('DRAFT'), READER);
    await ready();
    expect(screen.queryByRole('button', { name: vi_['cap.approval.submit.action'] })).toBeNull();
    expect(screen.getByTestId('actions').textContent).toContain(vi_['cap.approval.denied.notice']);
    cleanup();
    open(world('DRAFT'), SUBMITTER, undefined, { mode: 'READ_ONLY' });
    await ready();
    expect(screen.getByTestId('actions').textContent).toContain(vi_['cap.readOnly.frozen.notice']);
  });
});
