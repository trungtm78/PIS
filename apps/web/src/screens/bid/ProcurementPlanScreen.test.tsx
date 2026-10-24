import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import ProcurementPlanScreen from './ProcurementPlanScreen';
import { APPROVER, BOTH, DECISION_DOCUMENT, LINE, PLANNER, READER, client, mount, pack, plan, planId, routeOf, world } from './plan-test-support';

const ROUTE = routeOf('BID-15', 'FR-BID-15');
const problem = (code: string, status = 422, extensions: Record<string, unknown> = {}) => new ApiError({ status, code, correlationId: 'c', extensions });
const open = (n: number) => `/bid/bid-15?plan=${planId(n)}`;
const OK = { operation_id: 'o', status: 'IN_REVIEW', resource_version: 2, resource_id: planId(1) };

afterEach(cleanup);

const inReview = () => world({ plans: [plan(1, { status: 'IN_REVIEW', version: 2 })], packages: [pack(1, 1), pack(2, 1)] });

describe('ProcurementPlanScreen (BID-15): the procurement plans and the decision on them', () => {
  it('lists the plans with the project, revision, total, status in words and decision, and tells the reader to pick one (UI-BID-15)', async () => {
    const approved = plan(2, { status: 'APPROVED', revision: 2, decision_document: { id: DECISION_DOCUMENT, symbol: '45/QD-UBND', issued_on: '2026-10-01' } });
    mount(<ProcurementPlanScreen route={ROUTE} />, client(world({ plans: [approved, plan(1, { status: 'SUPERSEDED' })] })), { permissions: READER });
    const table = await screen.findByTestId('plans');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0] as HTMLElement).getByTestId('plan-status').textContent).toBe(vi_['bid.planStatus.approved.label']);
    expect(within(rows[0] as HTMLElement).getByText('45/QD-UBND')).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText('28.000.000.000')).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByTestId('plan-status').textContent).toBe(vi_['bid.planStatus.superseded.label']);
    expect(within(rows[1] as HTMLElement).getByText(vi_['bid.plans.noDecision.text'])).toBeTruthy();
    expect(screen.getByTestId('no-selection').textContent).toBe(vi_['bid.plans.noSelection.notice']);
    expect(screen.queryByText(vi_['bid.plans.create.link'])).toBeNull();
  });

  it('shows the packages of the chosen plan with the total and the words of the last decision, and says so when the plan is not there', async () => {
    const returned = plan(1, { status: 'DRAFT', last_decision: { decision: 'RETURNED', comment: 'Chia gói 2', decided_at: '2026-10-20T00:00:00.000000Z' } });
    mount(<ProcurementPlanScreen route={ROUTE} />, client(world({ plans: [returned] })), { permissions: PLANNER, path: open(1) });
    const detail = await screen.findByTestId('plan-detail');
    expect(within(detail).getAllByRole('row')).toHaveLength(3);
    expect(within(detail).getByText('Gói thầu xây lắp 1')).toBeTruthy();
    expect(within(detail).getAllByText(vi_['bid.method.open.label']).length).toBe(2);
    expect(screen.getByTestId('last-decision').textContent).toBe(`${vi_['bid.lastDecision.returned.label']}: Chia gói 2`);
    expect(detail.textContent).toContain('Tổng giá gói: 28.000.000.000 đồng');
    cleanup();
    mount(<ProcurementPlanScreen route={ROUTE} />, client(world()), { permissions: PLANNER, path: open(9) });
    expect((await screen.findByTestId('plan-missing')).textContent).toBe(vi_['bid.plans.missing.notice']);
  });

  it('lets a planner submit a draft with its version and says it is done; the actions of a plan are those of its state (UI-BID-15)', async () => {
    const h = client(world(), () => OK);
    mount(<ProcurementPlanScreen route={ROUTE} />, h, { permissions: PLANNER, path: open(1) });
    await userEvent.click(await screen.findByRole('button', { name: vi_['bid.plans.submit.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]?.[0]).toBe('submitProcurementPlan');
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: planId(1) }, ifMatchVersion: 1 });
    expect((await screen.findByTestId('submit-done')).textContent).toBe(vi_['bid.plans.submit.done']);
    expect(screen.getByRole('link', { name: vi_['bid.plans.revise.link'] }).getAttribute('href')).toBe(`/bid/bid-16?revise=${planId(1)}`);
    expect(screen.queryByTestId('decision-panel')).toBeNull();
  });

  it('names the lines that cost too much, with the figures, when the budget check refuses the submission', async () => {
    const excess = { lines: [{ allocation_line_id: LINE, allocated_vnd: '30000000000', packages_vnd: '33000000000', excess_vnd: '3000000000' }] };
    mount(<ProcurementPlanScreen route={ROUTE} />, client(world(), () => problem('PACKAGE_BUDGET_EXCEEDS_ALLOCATION', 422, excess)), { permissions: PLANNER, path: open(1) });
    await userEvent.click(await screen.findByRole('button', { name: vi_['bid.plans.submit.action'] }));
    const refusal = await screen.findByTestId('submit-refusal');
    expect(within(refusal).getByText(vi_['bid.planProblem.budgetExceeds.error'])).toBeTruthy();
    const row = within(screen.getByTestId('excess-lines')).getAllByRole('row')[1] as HTMLElement;
    expect(row.getAttribute('data-line-id')).toBe(LINE);
    expect(within(row).getByText('33.000.000.000')).toBeTruthy();
    expect(within(row).getByText('3.000.000.000')).toBeTruthy();
  });

  it.each([
    ['PROJECT_STAGE_INVALID', 'bid.planProblem.stageInvalid.error'],
    ['ALLOCATION_LINE_INVALID', 'bid.planProblem.lineInvalid.error'],
    ['VERSION_CONFLICT', 'bid.planProblem.versionConflict.error'],
    ['PLAN_STATE_INVALID', 'bid.planProblem.stateInvalid.error'],
    ['SOMETHING_ELSE', 'bid.planProblem.general.error'],
  ] as const)('says %s in words when the submission is refused', async (code, key) => {
    mount(<ProcurementPlanScreen route={ROUTE} />, client(world(), () => problem(code, 409)), { permissions: PLANNER, path: open(1) });
    await userEvent.click(await screen.findByRole('button', { name: vi_['bid.plans.submit.action'] }));
    expect((await screen.findByTestId('submit-refusal')).textContent).toContain(vi_[key]);
  });

  it('shows the decision panel to an approver of a plan in review only, approves on a document and sends the allowlisted body (UI-BID-15)', async () => {
    const h = client(inReview(), () => ({ ...OK, status: 'APPROVED' }));
    mount(<ProcurementPlanScreen route={ROUTE} />, h, { permissions: APPROVER, path: open(1) });
    const panel = await screen.findByTestId('decision-panel');
    expect(screen.queryByRole('button', { name: vi_['bid.plans.submit.action'] })).toBeNull();
    await userEvent.click(within(panel).getByRole('button', { name: vi_['bid.decisionPanel.submit.action'] }));
    expect(within(panel).getByText(vi_['bid.planField.required.error'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(panel).getByLabelText(vi_['bid.decisionPanel.document.label']), { target: { value: ` ${DECISION_DOCUMENT.toUpperCase()} ` } });
    await userEvent.click(within(panel).getByRole('button', { name: vi_['bid.decisionPanel.submit.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]?.[0]).toBe('decideProcurementPlan');
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: planId(1) }, body: { decision: 'APPROVE', decision_document_id: DECISION_DOCUMENT }, ifMatchVersion: 2 });
    expect((await screen.findByTestId('decision-done')).textContent).toBe(vi_['bid.decisionPanel.done.notice']);
  });

  it('asks for the words to return or reject, hides the document then, and shows the refusal of the maker and of a decision not in force', async () => {
    const h = client(inReview(), (_operation, input) => {
      const body = (input as { body: { decision: string } }).body;
      return body.decision === 'RETURN' ? problem('SELF_APPROVAL_DENIED', 403) : problem('DECISION_DOCUMENT_NOT_EFFECTIVE');
    });
    mount(<ProcurementPlanScreen route={ROUTE} />, h, { permissions: BOTH, path: open(1) });
    const panel = await screen.findByTestId('decision-panel');
    fireEvent.change(within(panel).getByLabelText(vi_['bid.decisionPanel.kind.label']), { target: { value: 'RETURN' } });
    expect(within(panel).queryByLabelText(vi_['bid.decisionPanel.document.label'])).toBeNull();
    await userEvent.click(within(panel).getByRole('button', { name: vi_['bid.decisionPanel.submit.action'] }));
    expect(within(panel).getByText(vi_['bid.planField.required.error'])).toBeTruthy();
    fireEvent.change(within(panel).getByLabelText(vi_['bid.decisionPanel.comment.label']), { target: { value: 'Chia gói 2' } });
    await userEvent.click(within(panel).getByRole('button', { name: vi_['bid.decisionPanel.submit.action'] }));
    expect((await within(panel).findByTestId('decision-refusal')).textContent).toContain(vi_['bid.planProblem.selfApproval.error']);
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ body: { decision: 'RETURN', comment: 'Chia gói 2' } });
    fireEvent.change(within(panel).getByLabelText(vi_['bid.decisionPanel.kind.label']), { target: { value: 'APPROVE' } });
    fireEvent.change(within(panel).getByLabelText(vi_['bid.decisionPanel.document.label']), { target: { value: DECISION_DOCUMENT } });
    await userEvent.click(within(panel).getByRole('button', { name: vi_['bid.decisionPanel.submit.action'] }));
    await waitFor(() => expect(within(panel).getByTestId('decision-refusal').textContent).toContain(vi_['bid.planProblem.decisionNotEffective.error']));
  });

  it('gives a reader and a read-only session no action, and a planner of an approved plan the link to a revision (UI-BID-15)', async () => {
    mount(<ProcurementPlanScreen route={ROUTE} />, client(inReview()), { permissions: READER, path: open(1) });
    await screen.findByTestId('plan-detail');
    expect(screen.queryByTestId('decision-panel')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    cleanup();
    mount(<ProcurementPlanScreen route={ROUTE} />, client(inReview()), { permissions: BOTH, path: open(1), mode: 'READ_ONLY' });
    await screen.findByTestId('plan-detail');
    expect(screen.queryByTestId('decision-panel')).toBeNull();
    expect(screen.queryByText(vi_['bid.plans.create.link'])).toBeNull();
    cleanup();
    mount(<ProcurementPlanScreen route={ROUTE} />, client(world({ plans: [plan(1, { status: 'APPROVED' })] })), { permissions: PLANNER, path: open(1) });
    expect((await screen.findByRole('link', { name: vi_['bid.plans.revise.link'] })).getAttribute('href')).toBe(`/bid/bid-16?revise=${planId(1)}`);
    expect(screen.getByRole('link', { name: vi_['bid.plans.create.link'] })).toBeTruthy();
    expect(screen.queryByRole('button', { name: vi_['bid.plans.submit.action'] })).toBeNull();
  });

  it('shows the empty state and the error state of the standard card (UI-BID-15)', async () => {
    mount(<ProcurementPlanScreen route={ROUTE} />, client(world({ plans: [] })), { permissions: READER });
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
    cleanup();
    mount(<ProcurementPlanScreen route={ROUTE} />, client(world({ failing: new Set(['listProcurementPlans']) })), { permissions: READER });
    expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
  });
});
