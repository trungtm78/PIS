import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { BILLION, PROJECT_A, PROJECT_B, PUBLISHED_ID, UNIT_ROOT, mount, planClient, planLine, planWorld, routeOf } from '../plan-test-support';
import type { Harness } from '../plan-test-support';
import ReallocationScreen from './ReallocationScreen';
import { balanceOf, finalAmounts, canApply, canDecide, canSubmit, describeReallocation, draftBody, toProposalPage, validateDecision, validateDocument, validateDraft } from './model';

const ROUTE = routeOf('CAP-19', 'FR-CAP-19');
const ME = '00000000-0000-4000-8000-000000000001'; // the member of the session of the test support
const OTHER = '00000000-0000-4000-8000-0000000000c2';
const THIRD = '00000000-0000-4000-8000-0000000000c3';
const PROPOSER = ['capital.read', 'plan_version.read', 'capital.reallocation.propose'];
const DECIDER = ['capital.read', 'capital.reallocation.approve'];
const APPLIER = ['capital.read', 'capital.reallocation.apply'];
const READER = ['capital.read'];
const SNAPSHOT = '00000000-0000-4000-8000-0000000000d1';
const DOCUMENT = '00000000-0000-4000-8000-0000000000d2';
const OK = { operation_id: 'o', status: 'DRAFT', resource_version: 1, resource_id: 'x' };
const vnd = (billions: number): string => String(billions * BILLION);

const proposal = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-0000000000e${n}`,
  code: `RP-${n}`,
  plan_year: 2025,
  scope_unit: { id: UNIT_ROOT, name: 'Sở Tài chính' },
  basis_snapshot_id: SNAPSHOT,
  source_capital_plan_id: PUBLISHED_ID,
  reason: 'Move capital from the slow bridge to the fast road',
  status: 'SUBMITTED',
  decision_document_id: null,
  resulting_capital_plan_id: null,
  submitted_by: OTHER,
  approved_by: null,
  decision_reason: null,
  created_by: OTHER,
  created_at: '2026-10-24T01:00:00.000000Z',
  applied_at: null,
  version: 2,
  total_vnd: vnd(2),
  lines: [
    {
      id: `00000000-0000-4000-8000-0000000001a${n}`,
      from_allocation_line_id: planLine(1).id,
      from_project: { id: PROJECT_A, code: 'DA-01', name: 'Đường vành đai 3' },
      to_allocation_line_id: planLine(2).id,
      to_project: { id: PROJECT_B, code: 'DA-02', name: 'Cầu Thủ Thiêm 4' },
      appropriation_id: null,
      amount_vnd: vnd(2),
      from_allocated_vnd: vnd(5),
      to_allocated_vnd: vnd(1),
      rationale: { note: 'Project A is twenty points behind the curve' },
    },
  ],
  ...overrides,
});

afterEach(cleanup);

interface Served {
  pages: Array<Record<string, unknown>>;
  failing?: Error;
}

const frozenSnapshot = {
  id: SNAPSHOT,
  period_id: '00000000-0000-4000-8000-0000000000f1',
  snapshot_kind: 'PERIOD_CLOSE',
  status: 'FROZEN',
  as_of_date: '2026-10-31',
  treasury_cutoff_date: '2026-10-31',
  definition_status: 'PROPOSED_PENDING_SIGNOFF',
  row_count: 3,
  payload_sha256: 'a'.repeat(64),
  frozen_at: '2026-11-01T00:00:00Z',
  supersedes_id: null,
  created_at: '2026-10-31T00:00:00Z',
  version: 2,
};

function open(served: Served, command: (operation: string, input: unknown) => unknown = () => OK): Harness {
  const h = planClient(planWorld(), command);
  const previous = h.read.getMockImplementation();
  let call = 0;
  h.read.mockImplementation((operation: string, input?: unknown) => {
    if (operation === 'listReallocationProposals') {
      if (served.failing !== undefined) return Promise.reject(served.failing);
      const page = served.pages[Math.min(call, served.pages.length - 1)];
      call += 1;
      return Promise.resolve(page);
    }
    if (operation === 'listPeriodSnapshots') return Promise.resolve({ items: [frozenSnapshot], pending_reports: [], next_cursor: null });
    return previous === undefined ? Promise.reject(new Error(`unexpected read ${operation}`)) : previous(operation, input);
  });
  return h;
}

const page = (items: unknown[], next: string | null = null) => ({ items, next_cursor: next, as_of: '2026-10-27' });
const show = (h: Harness, permissions: readonly string[], mode?: 'FULL' | 'READ_ONLY') => mount(<ReallocationScreen route={ROUTE} />, h, { permissions, ...(mode === undefined ? {} : { mode }), path: '/cap/cap-19' });
const asked = (h: Harness) => h.read.mock.calls.filter(([operation]) => operation === 'listReallocationProposals').map(([, input]) => (input as { query: Record<string, unknown> }).query);
const choose = async (label: string, value: string, scope: HTMLElement | undefined = undefined) => {
  const select = (await (scope === undefined ? screen.findByLabelText(label) : within(scope).findByLabelText(label))) as HTMLSelectElement;
  await waitFor(() => expect(Array.from(select.options).some((option) => option.value === value)).toBe(true));
  fireEvent.change(select, { target: { value } });
};

describe('ReallocationScreen (CAP-19): the reallocation of capital from slow to fast projects', () => {
  it('UI-CAP-19: lists the proposals with the code, the year, the lines, the total and the state in words; a reader only reads, and sees the donor on the left and the recipient on the right, each before and after, with the balance under them', async () => {
    const h = open({ pages: [page([proposal(1), proposal(2, { status: 'APPLIED', decision_reason: 'Reviewed against the snapshot', resulting_capital_plan_id: PUBLISHED_ID })])] });
    show(h, READER);
    const table = await screen.findByTestId('proposals');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['cap.reallocation.page.title']);
    for (const key of ['cap.reallocation.col.code', 'cap.reallocation.col.year', 'cap.reallocation.col.lines', 'cap.reallocation.col.total', 'cap.reallocation.col.status'] as const) {
      expect(within(table).getByRole('columnheader', { name: vi_[key] })).toBeTruthy();
    }
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]?.textContent).toContain('RP-1');
    expect(rows[0]?.textContent).toContain(vi_['cap.reallocation.status.submitted']);
    expect(rows[0]?.textContent).toContain(vi_['cap.reallocation.money'].replace('{amount}', BigInt(vnd(2)).toLocaleString('vi-VN')));
    expect(rows[1]?.textContent).toContain(vi_['cap.reallocation.status.applied']);
    expect(rows[1]?.textContent).toContain(vi_['cap.reallocation.decision.note'].replace('{note}', 'Reviewed against the snapshot'));
    expect(screen.queryByRole('form', { name: vi_['cap.reallocation.form.title'] })).toBeNull();
    for (const key of ['cap.reallocation.submit.action', 'cap.reallocation.decide.action', 'cap.reallocation.apply.action'] as const) expect(screen.queryByRole('button', { name: vi_[key] })).toBeNull();
    fireEvent.click(within(rows[0] as HTMLElement).getByRole('button', { name: vi_['cap.reallocation.view.action'] }));
    const compare = await screen.findByTestId('reallocation-compare');
    expect(within(compare).getByTestId('compare-left').textContent).toBe(
      vi_['cap.reallocation.compare.side'].replace('{project}', 'DA-01 Đường vành đai 3').replace('{before}', BigInt(vnd(5)).toLocaleString('vi-VN')).replace('{after}', BigInt(vnd(3)).toLocaleString('vi-VN')),
    );
    expect(within(compare).getByTestId('compare-right').textContent).toContain(
      vi_['cap.reallocation.compare.side'].replace('{project}', 'DA-02 Cầu Thủ Thiêm 4').replace('{before}', BigInt(vnd(1)).toLocaleString('vi-VN')).replace('{after}', BigInt(vnd(3)).toLocaleString('vi-VN')),
    );
    expect(within(compare).getByTestId('compare-right').textContent).toContain('Project A is twenty points behind the curve');
    const two = BigInt(vnd(2)).toLocaleString('vi-VN');
    expect(within(compare).getByTestId('compare-balance').textContent).toBe(vi_['cap.reallocation.compare.balance'].replace('{reduced}', two).replace('{increased}', two));
  });

  describe('drafting (AC-ST-CAP-010-1)', () => {
    it('AC-ST-CAP-010-1: draws a proposal on a frozen snapshot of a plan in force, with a line that takes from a line and gives to another project, and sends it', async () => {
      const h = open({ pages: [page([])] }, () => OK);
      show(h, PROPOSER);
      const form = await screen.findByRole('form', { name: vi_['cap.reallocation.form.title'] });
      fireEvent.change(within(form).getByLabelText(vi_['cap.reallocation.field.code.label']), { target: { value: 'RP-NEW' } });
      await choose(vi_['cap.reallocation.field.plan.label'], PUBLISHED_ID, form);
      await choose(vi_['cap.reallocation.field.snapshot.label'], SNAPSHOT, form);
      fireEvent.change(within(form).getByLabelText(vi_['cap.reallocation.field.reason.label']), { target: { value: 'Move capital from the slow bridge to the fast road' } });
      await choose(vi_['cap.reallocation.field.from.label'], planLine(1).id as string, form);
      await choose(vi_['cap.reallocation.field.to.label'], PROJECT_B, form);
      fireEvent.change(within(form).getByLabelText(vi_['cap.reallocation.field.amount.label']), { target: { value: vnd(2) } });
      fireEvent.change(within(form).getByLabelText(vi_['cap.reallocation.field.note.label']), { target: { value: 'Behind the curve' } });
      fireEvent.click(within(form).getByRole('button', { name: vi_['cap.reallocation.form.submit.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('draftReallocationProposal');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({
        body: {
          code: 'RP-NEW',
          plan_year: 2025,
          scope_unit_id: UNIT_ROOT,
          basis_snapshot_id: SNAPSHOT,
          source_capital_plan_id: PUBLISHED_ID,
          reason: 'Move capital from the slow bridge to the fast road',
          lines: [{ from_allocation_line_id: planLine(1).id, to_project_id: PROJECT_B, amount_vnd: vnd(2), rationale: 'Behind the curve' }],
        },
      });
      expect((await screen.findByTestId('draft-saved')).textContent).toBe(vi_['cap.reallocation.form.saved']);
    });

    it('refuses before it sends what is missing, a move to the same project, an amount that is not whole dong and the same pair twice, and says in words what the server refuses', async () => {
      const h = open({ pages: [page([])] }, () => new ApiError({ status: 422, code: 'TRANSFER_UNBALANCED', correlationId: 'c' }));
      show(h, PROPOSER);
      const form = await screen.findByRole('form', { name: vi_['cap.reallocation.form.title'] });
      fireEvent.click(within(form).getByRole('button', { name: vi_['cap.reallocation.form.submit.action'] }));
      expect((await within(form).findAllByText(vi_['cap.reallocation.field.required.error'])).length).toBeGreaterThanOrEqual(5);
      expect(h.command).not.toHaveBeenCalled();
      fireEvent.change(within(form).getByLabelText(vi_['cap.reallocation.field.code.label']), { target: { value: 'RP-NEW' } });
      await choose(vi_['cap.reallocation.field.plan.label'], PUBLISHED_ID, form);
      await choose(vi_['cap.reallocation.field.snapshot.label'], SNAPSHOT, form);
      fireEvent.change(within(form).getByLabelText(vi_['cap.reallocation.field.reason.label']), { target: { value: 'Move capital from the slow bridge to the fast road' } });
      await choose(vi_['cap.reallocation.field.from.label'], planLine(1).id as string, form);
      await choose(vi_['cap.reallocation.field.to.label'], PROJECT_A, form);
      fireEvent.change(within(form).getByLabelText(vi_['cap.reallocation.field.amount.label']), { target: { value: '1.5' } });
      fireEvent.click(within(form).getByRole('button', { name: vi_['cap.reallocation.form.submit.action'] }));
      expect(await within(form).findByText(vi_['cap.reallocation.field.same.error'])).toBeTruthy();
      expect(within(form).getByText(vi_['cap.reallocation.field.invalid.error'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
      await choose(vi_['cap.reallocation.field.to.label'], PROJECT_B, form);
      fireEvent.change(within(form).getByLabelText(vi_['cap.reallocation.field.amount.label']), { target: { value: vnd(1) } });
      fireEvent.click(within(form).getByRole('button', { name: vi_['cap.reallocation.form.submit.action'] }));
      expect((await within(form).findByTestId('draft-refusal')).textContent).toBe(vi_['cap.reallocation.problem.unbalanced']);
    });

    it('adds and removes lines, and offers the form only to the person who may propose', async () => {
      const h = open({ pages: [page([])] });
      show(h, PROPOSER);
      const form = await screen.findByRole('form', { name: vi_['cap.reallocation.form.title'] });
      expect(within(form).getAllByTestId('draft-line')).toHaveLength(1);
      expect(within(form).queryByRole('button', { name: vi_['cap.reallocation.lines.remove.action'] })).toBeNull();
      fireEvent.click(within(form).getByRole('button', { name: vi_['cap.reallocation.lines.add.action'] }));
      expect(within(form).getAllByTestId('draft-line')).toHaveLength(2);
      fireEvent.click(within(form).getAllByRole('button', { name: vi_['cap.reallocation.lines.remove.action'] })[0] as HTMLElement);
      expect(within(form).getAllByTestId('draft-line')).toHaveLength(1);
      cleanup();
      show(open({ pages: [page([proposal(1)])] }), PROPOSER, 'READ_ONLY');
      await screen.findByTestId('proposals');
      expect(screen.queryByRole('form', { name: vi_['cap.reallocation.form.title'] })).toBeNull();
    });
  });

  describe('submitting, deciding and applying', () => {
    it('submits a draft under the version the list showed, and says in words why the server refused', async () => {
      const h = open({ pages: [page([proposal(1, { status: 'DRAFT', created_by: ME, submitted_by: null, version: 1 })])] }, () => new ApiError({ status: 409, code: 'PLAN_CHANGED_SINCE_PROPOSAL', correlationId: 'c' }));
      show(h, PROPOSER);
      fireEvent.click(await screen.findByRole('button', { name: vi_['cap.reallocation.submit.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('submitReallocationProposal');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: proposal(1).id }, ifMatchVersion: 1 });
      expect((await screen.findByTestId('submit-refusal')).textContent).toBe(vi_['cap.reallocation.problem.planChanged']);
    });

    it('decides a proposal that waits (never one of the member as author or submitter), with a reason, and says why a decision was refused', async () => {
      const h = open({ pages: [page([proposal(1, { version: 5 }), proposal(2, { created_by: ME }), proposal(3, { submitted_by: ME }), proposal(4, { status: 'APPROVED' })])] }, () => new ApiError({ status: 403, code: 'SELF_APPROVAL_DENIED', correlationId: 'c' }));
      show(h, DECIDER);
      const buttons = await screen.findAllByRole('button', { name: vi_['cap.reallocation.decide.action'] });
      expect(buttons).toHaveLength(1);
      fireEvent.click(buttons[0] as HTMLElement);
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByTestId('decide-summary').textContent).toBe(vi_['cap.reallocation.decide.summary'].replace('{total}', BigInt(vnd(2)).toLocaleString('vi-VN')).replace('{lines}', '1'));
      fireEvent.click(within(dialog).getByRole('button', { name: vi_['cap.reallocation.decide.submit.action'] }));
      expect(await within(dialog).findByText(vi_['cap.reallocation.field.required.error'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
      fireEvent.click(within(dialog).getByRole('radio', { name: vi_['cap.reallocation.decide.return'] }));
      fireEvent.change(within(dialog).getByLabelText(vi_['cap.reallocation.decide.reason.label']), { target: { value: 'Change the amounts first' } });
      fireEvent.click(within(dialog).getByRole('button', { name: vi_['cap.reallocation.decide.submit.action'] }));
      expect((await within(dialog).findByTestId('decide-refusal')).textContent).toBe(vi_['cap.reallocation.problem.selfApproval']);
      expect(h.command.mock.calls[0]?.[0]).toBe('decideReallocationProposal');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: proposal(1).id }, ifMatchVersion: 5, body: { decision: 'return', reason: 'Change the amounts first' } });
    });

    it('applies an approved proposal only with the decision document, and offers it to nobody else but the person who may apply', async () => {
      const h = open({ pages: [page([proposal(1, { status: 'APPROVED', version: 3 }), proposal(2, { status: 'SUBMITTED' })])] }, () => ({ ...OK, status: 'APPLIED' }));
      show(h, APPLIER);
      const buttons = await screen.findAllByRole('button', { name: vi_['cap.reallocation.apply.action'] });
      expect(buttons).toHaveLength(1);
      fireEvent.click(buttons[0] as HTMLElement);
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByTestId('apply-summary').textContent).toBe(vi_['cap.reallocation.apply.summary'].replace('{total}', BigInt(vnd(2)).toLocaleString('vi-VN')).replace('{lines}', '1'));
      fireEvent.click(within(dialog).getByRole('button', { name: vi_['cap.reallocation.apply.submit.action'] }));
      expect(await within(dialog).findByText(vi_['cap.reallocation.field.required.error'])).toBeTruthy();
      fireEvent.change(within(dialog).getByLabelText(vi_['cap.reallocation.apply.document.label']), { target: { value: 'a document' } });
      fireEvent.click(within(dialog).getByRole('button', { name: vi_['cap.reallocation.apply.submit.action'] }));
      expect(await within(dialog).findByText(vi_['cap.reallocation.field.invalid.error'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
      fireEvent.change(within(dialog).getByLabelText(vi_['cap.reallocation.apply.document.label']), { target: { value: DOCUMENT } });
      fireEvent.click(within(dialog).getByRole('button', { name: vi_['cap.reallocation.apply.submit.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('applyReallocationProposal');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: proposal(1).id }, ifMatchVersion: 3, body: { decision_document_id: DOCUMENT } });
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });
  });

  it('narrows the list by status and loads the next page by cursor', async () => {
    const h = open({ pages: [page([proposal(1)], 'next'), page([proposal(2)])] });
    show(h, READER);
    await screen.findByTestId('proposals');
    fireEvent.click(await screen.findByRole('button', { name: vi_['cap.reallocation.more.action'] }));
    await waitFor(() => expect(screen.getByTestId('proposals').querySelectorAll('tbody tr')).toHaveLength(2));
    expect(asked(h)).toEqual([{ limit: 25 }, { limit: 25, cursor: 'next' }]);
    fireEvent.change(screen.getByLabelText(vi_['cap.reallocation.filter.status.label']), { target: { value: 'APPROVED' } });
    await waitFor(() => expect(asked(h).at(-1)).toEqual({ limit: 25, status: 'APPROVED' }));
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

describe('the reallocation model', () => {
  it('reads a page and drops what is not whole, and names the refusals of the server', () => {
    expect(toProposalPage(undefined)).toEqual({ items: [], nextCursor: undefined });
    const read = toProposalPage({ items: [proposal(1), { id: 'x' }, proposal(2, { status: 'NOPE' })], next_cursor: 'c' });
    expect(read.items.map((item) => item.code)).toEqual(['RP-1']);
    expect(read.items[0]?.lines[0]).toMatchObject({ amountVnd: vnd(2), note: 'Project A is twenty points behind the curve' });
    expect(read.nextCursor).toBe('c');
    const codes = ['TRANSFER_UNBALANCED', 'REVISED_BELOW_COMMITTED', 'SNAPSHOT_NOT_FROZEN', 'PLAN_CHANGED_SINCE_PROPOSAL', 'REVISION_PENDING_EXISTS', 'SELF_APPROVAL_DENIED', 'VERSION_CONFLICT', 'STAGE_TRANSITION_DENIED', 'DECISION_REQUIRED', 'DUPLICATE_KEY', 'SCOPE_DENIED', 'VALIDATION_FAILED', 'RESOURCE_NOT_FOUND', 'OTHER'];
    expect(codes.map((code) => describeReallocation(new ApiError({ status: 409, code, correlationId: 'c' })))).toEqual([
      'unbalanced',
      'belowCommitted',
      'snapshotNotFrozen',
      'planChanged',
      'pendingRevision',
      'selfApproval',
      'versionConflict',
      'stageDenied',
      'documentRequired',
      'duplicate',
      'scopeDenied',
      'validation',
      'notFound',
      'general',
    ]);
    expect(describeReallocation(new Error('x'))).toBe('general');
  });

  it('decides what a person may do: submit a draft, decide or apply as someone who is neither the author nor the submitter, and tells the figures of a line before and after as exact whole numbers', () => {
    expect([canSubmit({ status: 'DRAFT' }), canSubmit({ status: 'SUBMITTED' })]).toEqual([true, false]);
    expect([canDecide({ status: 'SUBMITTED', createdBy: OTHER, submittedBy: THIRD }, ME), canDecide({ status: 'SUBMITTED', createdBy: ME, submittedBy: THIRD }, ME), canDecide({ status: 'SUBMITTED', createdBy: OTHER, submittedBy: ME }, ME), canDecide({ status: 'APPROVED', createdBy: OTHER, submittedBy: THIRD }, ME)]).toEqual([true, false, false, false]);
    expect([canApply({ status: 'APPROVED', createdBy: OTHER, submittedBy: THIRD }, ME), canApply({ status: 'APPROVED', createdBy: OTHER, submittedBy: ME }, ME), canApply({ status: 'SUBMITTED', createdBy: OTHER, submittedBy: THIRD }, ME)]).toEqual([true, false, false]);
    const line = (from: string, to: string, amount: string, fromHeld: string, toHeld: string) => ({ amountVnd: amount, fromAllocatedVnd: fromHeld, toAllocatedVnd: toHeld, fromAllocationLineId: from, toAllocationLineId: to, toProject: { id: `p-${to}`, code: '', name: '' } });
    const one = [line('a', 'b', '2000000000000000000000', '5000000000000000000000', '1')];
    expect([finalAmounts(one).fromAfter(one[0] as never), finalAmounts(one).toAfter(one[0] as never)]).toEqual(['3000000000000000000000', '2000000000000000000001']);
    // A donor that gives twice ends with both taken off, a recipient that receives twice with both added, and a line that gives and receives with the difference.
    const many = [line('a', 'b', '20', '100', '10'), line('a', 'c', '30', '100', '5'), line('d', 'b', '7', '40', '10'), line('b', 'e', '4', '10', '0')];
    const total = finalAmounts(many);
    expect(many.map((each) => [total.fromAfter(each as never), total.toAfter(each as never)])).toEqual([['50', '33'], ['50', '35'], ['33', '33'], ['33', '4']]);
    expect(balanceOf([{ amountVnd: '5' }, { amountVnd: '7' }])).toEqual({ reducedVnd: '12', increasedVnd: '12', balanced: true });
  });

  it('judges the forms and builds what the server reads', () => {
    const blank = { code: '', planId: '', snapshotId: '', reason: '', lines: [{ fromLineId: '', toProjectId: '', amount: '', note: '' }] };
    const projectOf = (lineId: string): string | undefined => (lineId === 'l1' ? 'p1' : undefined);
    expect(validateDraft(blank, projectOf)).toEqual({ code: 'required', planId: 'required', snapshotId: 'required', reason: 'required', lines: [{ fromLineId: 'required', toProjectId: 'required', amount: 'required' }] });
    const filled = { code: 'RP', planId: 'plan', snapshotId: 's', reason: 'Move capital from the slow bridge to the fast road' };
    expect(validateDraft({ ...filled, lines: [{ fromLineId: 'l1', toProjectId: 'p1', amount: '0', note: '' }, { fromLineId: 'l1', toProjectId: 'p2', amount: '5', note: '' }, { fromLineId: 'l1', toProjectId: 'p2', amount: '5', note: '' }] }, projectOf)).toEqual({
      lines: [{ toProjectId: 'same', amount: 'invalid' }, {}, { fromLineId: 'duplicate' }],
    });
    expect(validateDraft({ ...filled, code: 'x'.repeat(51), reason: 'short', lines: [{ fromLineId: 'l1', toProjectId: 'p2', amount: '5', note: '' }] }, projectOf)).toEqual({ code: 'invalid', reason: 'invalid', lines: [{}] });
    expect(draftBody({ ...filled, code: ' RP ', lines: [{ fromLineId: 'l1', toProjectId: 'p2', amount: ' 5 ', note: '' }] }, { id: 'plan', planYear: 2025, scopeUnitId: 'u' })).toEqual({
      code: 'RP',
      plan_year: 2025,
      scope_unit_id: 'u',
      basis_snapshot_id: 's',
      source_capital_plan_id: 'plan',
      reason: 'Move capital from the slow bridge to the fast road',
      lines: [{ from_allocation_line_id: 'l1', to_project_id: 'p2', amount_vnd: '5' }],
    });
    expect([validateDecision(''), validateDecision('four'), validateDecision('five5')]).toEqual(['required', 'invalid', undefined]);
    expect([validateDocument(''), validateDocument('x'), validateDocument(DOCUMENT)]).toEqual(['required', 'invalid', undefined]);
  });
});
