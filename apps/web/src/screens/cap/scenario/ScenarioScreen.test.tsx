import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { BILLION, PROJECT_A, PROJECT_B, PUBLISHED_ID, UNIT_ROOT, mount, planClient, planLine, planWorld, routeOf } from '../plan-test-support';
import type { Harness } from '../plan-test-support';
import ScenarioScreen from './ScenarioScreen';
import { changeOf, describeScenario, holds, scenarioBody, toScenarioPage, validateForm, violationsOf } from './model';
import type { ScenarioForm } from './model';

const ROUTE = routeOf('CAP-09', 'FR-CAP-09');
const RUNNER = ['capital.read', 'plan_version.read', 'capital.scenario.run'];
const PROPOSER = ['capital.read', 'capital.reallocation.propose'];
const READER = ['capital.read'];
const SNAPSHOT = '00000000-0000-4000-8000-0000000000d1';
const OK = { operation_id: 'o', status: 'DRAFT', resource_version: 1, resource_id: 'x' };
const vnd = (billions: number): string => String(billions * BILLION);
const dong = (value: string): string => BigInt(value).toLocaleString('vi-VN');

const scenario = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-0000000000e${n}`,
  code: `SC-${n}`,
  plan_year: 2025,
  base_capital_plan: { id: PUBLISHED_ID, plan_code: 'KH-2025', scope_unit: { id: UNIT_ROOT, name: 'Sở Tài chính' } },
  input_snapshot_id: SNAPSHOT,
  constraints: { min_remaining_vnd: vnd(1) },
  assumptions: { moves: [{ from_allocation_line_id: planLine(1).id, to_project_id: PROJECT_B, amount_vnd: vnd(2), rationale: 'Behind the curve' }] },
  result: {
    ran_at: '2026-10-31T01:00:00.000Z',
    total_moved_vnd: vnd(2),
    projects: [
      { project_id: PROJECT_A, before_vnd: vnd(5), after_vnd: vnd(3) },
      { project_id: PROJECT_B, before_vnd: vnd(1), after_vnd: vnd(3) },
    ],
    lines: [
      { allocation_line_id: planLine(1).id, project_id: PROJECT_A, before_vnd: vnd(5), after_vnd: vnd(3), minimum_vnd: vnd(1) },
      { allocation_line_id: planLine(2).id, project_id: PROJECT_B, before_vnd: vnd(1), after_vnd: vnd(3), minimum_vnd: '0' },
    ],
    moves: [],
  },
  status: 'RUN',
  promoted_proposal_id: null,
  created_by: '00000000-0000-4000-8000-0000000000c2',
  created_at: '2026-10-31T00:00:00.000Z',
  updated_at: '2026-10-31T01:00:00.000Z',
  actions: { run: true, promote: true },
  version: 2,
  ...overrides,
});

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

interface Served {
  pages: Array<Record<string, unknown>>;
  failing?: Error;
}

function open(served: Served, command: (operation: string, input: unknown) => unknown = () => OK): Harness {
  const h = planClient(planWorld(), command);
  const previous = h.read.getMockImplementation();
  let call = 0;
  h.read.mockImplementation((operation: string, input?: unknown) => {
    if (operation === 'listAllocationScenarios') {
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

const page = (items: unknown[], next: string | null = null) => ({ items, next_cursor: next, as_of: '2026-10-31T00:00:00.000Z' });
const show = (h: Harness, permissions: readonly string[], mode?: 'FULL' | 'READ_ONLY') => mount(<ScenarioScreen route={ROUTE} />, h, { permissions, ...(mode === undefined ? {} : { mode }), path: '/cap/cap-09' });
const asked = (h: Harness) => h.read.mock.calls.filter(([operation]) => operation === 'listAllocationScenarios').map(([, input]) => (input as { query: Record<string, unknown> }).query);
const choose = async (label: string, value: string, scope: HTMLElement | undefined = undefined) => {
  const select = (await (scope === undefined ? screen.findByLabelText(label) : within(scope).findByLabelText(label))) as HTMLSelectElement;
  await waitFor(() => expect(Array.from(select.options).some((option) => option.value === value)).toBe(true));
  fireEvent.change(select, { target: { value } });
};

afterEach(cleanup);

describe('ScenarioScreen (CAP-09): the simulation of an allocation', () => {
  it('UI-CAP-09: lists the scenarios with the code, the plan, the moves, the total moved and the state in words, and shows each project before and after with the note that nothing was written', async () => {
    const h = open({ pages: [page([scenario(1), scenario(2, { status: 'DRAFT', result: null, actions: { run: true, promote: false }, version: 1 })])] });
    show(h, [...RUNNER, ...PROPOSER]);
    const table = await screen.findByTestId('scenarios');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['cap.scenario.page.title']);
    for (const key of ['cap.scenario.col.code', 'cap.scenario.col.plan', 'cap.scenario.col.moves', 'cap.scenario.col.total', 'cap.scenario.col.status'] as const) {
      expect(within(table).getByRole('columnheader', { name: vi_[key] })).toBeTruthy();
    }
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]?.textContent).toContain('SC-1');
    expect(rows[0]?.textContent).toContain(vi_['cap.scenario.status.run']);
    expect(rows[0]?.textContent).toContain(vi_['cap.scenario.money'].replace('{amount}', dong(vnd(2))));
    expect(rows[0]?.textContent).toContain(vi_['cap.scenario.plan.value'].replace('{code}', 'KH-2025').replace('{year}', '2025'));
    expect(rows[1]?.textContent).toContain(vi_['cap.scenario.status.draft']);
    // A scenario that was not run has no result to view, and offers the run; a run one offers to run again and to promote.
    expect(within(rows[1] as HTMLElement).queryByRole('button', { name: vi_['cap.scenario.view.action'] })).toBeNull();
    expect(within(rows[1] as HTMLElement).getByRole('button', { name: vi_['cap.scenario.run.action'] })).toBeTruthy();
    expect(within(rows[1] as HTMLElement).queryByRole('button', { name: vi_['cap.scenario.promote.action'] })).toBeNull();
    expect(within(rows[0] as HTMLElement).getByRole('button', { name: vi_['cap.scenario.rerun.action'] })).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByRole('button', { name: vi_['cap.scenario.promote.action'] })).toBeTruthy();
    fireEvent.click(within(rows[0] as HTMLElement).getByRole('button', { name: vi_['cap.scenario.view.action'] }));
    const result = await screen.findByTestId('scenario-result');
    expect(within(result).getByTestId('result-note').textContent).toBe(vi_['cap.scenario.result.note']);
    const body = within(result).getAllByRole('row').slice(1);
    expect(body).toHaveLength(2);
    expect(body[0]?.textContent).toContain(dong(vnd(5)));
    expect(body[0]?.textContent).toContain(dong(vnd(3)));
    expect(within(body[0] as HTMLElement).getByTestId('project-change').textContent).toBe(`-${dong(vnd(2))}`);
    expect(within(body[1] as HTMLElement).getByTestId('project-change').textContent).toBe(`+${dong(vnd(2))}`);
    expect(within(result).getByTestId('result-total').textContent).toBe(vi_['cap.scenario.result.total'].replace('{amount}', dong(vnd(2))));
    fireEvent.click(within(result).getByRole('button', { name: vi_['cap.scenario.result.close.action'] }));
    expect(screen.queryByTestId('scenario-result')).toBeNull();
  });

  it('tells a promoted scenario from the others, and a reader only reads: no form, no run, no promotion', async () => {
    const h = open({ pages: [page([scenario(1, { status: 'PROMOTED', promoted_proposal_id: SNAPSHOT, actions: { run: false, promote: false }, version: 3 })])] });
    show(h, READER);
    const table = await screen.findByTestId('scenarios');
    expect(screen.queryByRole('form', { name: vi_['cap.scenario.form.title'] })).toBeNull();
    for (const key of ['cap.scenario.run.action', 'cap.scenario.rerun.action', 'cap.scenario.promote.action'] as const) expect(screen.queryByRole('button', { name: vi_[key] })).toBeNull();
    fireEvent.click(within(table).getByRole('button', { name: vi_['cap.scenario.view.action'] }));
    expect((await screen.findByTestId('result-note')).textContent).toBe(vi_['cap.scenario.result.promoted']);
  });

  it('reads the list again for a status, a page at a time', async () => {
    const h = open({ pages: [page([scenario(1)], 'next-page'), page([scenario(2, { status: 'DRAFT', result: null })])] });
    show(h, RUNNER);
    await screen.findByTestId('scenarios');
    fireEvent.click(screen.getByRole('button', { name: vi_['cap.scenario.more.action'] }));
    await waitFor(() => expect(within(screen.getByTestId('scenarios')).getAllByRole('row')).toHaveLength(3));
    expect(asked(h)[1]).toMatchObject({ cursor: 'next-page' });
    fireEvent.change(screen.getByLabelText(vi_['cap.scenario.filter.status.label']), { target: { value: 'RUN' } });
    await waitFor(() => expect(asked(h).some((query) => query.status === 'RUN')).toBe(true));
  });

  it('shows the empty state to someone who may not create, and the failure with a way to read again', async () => {
    const empty = open({ pages: [page([])] });
    show(empty, READER);
    await waitFor(() => expect(screen.queryByTestId('scenarios')).toBeNull());
    cleanup();
    const failing = open({ pages: [], failing: new ApiError({ status: 503, code: 'DEPENDENCY_UNAVAILABLE', correlationId: 'c' }) });
    show(failing, READER);
    const retry = await screen.findByRole('button', { name: vi_['states.retry.action'] });
    expect(screen.queryByTestId('scenarios')).toBeNull();
    const before = asked(failing).length;
    fireEvent.click(retry);
    await waitFor(() => expect(asked(failing).length).toBeGreaterThan(before));
  });

  describe('running and promoting', () => {
    it('runs a scenario under the version the list showed, and promotes a run one', async () => {
      const h = open({ pages: [page([scenario(1)])] });
      show(h, [...RUNNER, ...PROPOSER]);
      fireEvent.click(await screen.findByRole('button', { name: vi_['cap.scenario.rerun.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('runAllocationScenario');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: scenario(1).id }, ifMatchVersion: 2 });
      fireEvent.click(await screen.findByRole('button', { name: vi_['cap.scenario.promote.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
      expect(h.command.mock.calls[1]?.[0]).toBe('promoteAllocationScenario');
      expect(h.command.mock.calls[1]?.[1]).toMatchObject({ path: { id: scenario(1).id }, ifMatchVersion: 2 });
    });

    it('says in words which limits an infeasible run broke, and what the server refuses on a promotion', async () => {
      const infeasible = new ApiError({
        status: 422,
        code: 'SCENARIO_CONSTRAINT_INFEASIBLE',
        correlationId: 'c',
        extensions: { violations: [{ kind: 'BELOW_MINIMUM' }, { kind: 'TOTAL_ABOVE_LIMIT' }, { kind: 'NO_RECIPIENT_LINE' }, { kind: 'MOVE_ABOVE_LIMIT' }, { kind: 'SOMETHING_NEW' }] },
      });
      const h = open({ pages: [page([scenario(1, { status: 'DRAFT', result: null, version: 1 })])] }, () => infeasible);
      show(h, [...RUNNER, ...PROPOSER]);
      fireEvent.click(await screen.findByRole('button', { name: vi_['cap.scenario.run.action'] }));
      const alert = await screen.findByTestId('step-refusal');
      expect(within(alert).getByText(vi_['cap.scenario.problem.infeasible'])).toBeTruthy();
      expect(within(alert).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
        vi_['cap.scenario.violation.belowMinimum'],
        vi_['cap.scenario.violation.totalAboveLimit'],
        vi_['cap.scenario.violation.noRecipientLine'],
        vi_['cap.scenario.violation.moveAboveLimit'],
        'SOMETHING_NEW',
      ]);
    });

    it('says why a promotion was refused', async () => {
      const h = open({ pages: [page([scenario(1)])] }, () => new ApiError({ status: 422, code: 'SNAPSHOT_NOT_FROZEN', correlationId: 'c' }));
      show(h, PROPOSER);
      fireEvent.click(await screen.findByRole('button', { name: vi_['cap.scenario.promote.action'] }));
      expect((await screen.findByTestId('step-refusal')).textContent).toBe(vi_['cap.scenario.problem.snapshotNotFrozen']);
      expect(screen.queryByTestId('violations')).toBeNull();
    });
  });

  describe('creating', () => {
    it('draws a scenario on a plan in force with limits and a move, and sends it', async () => {
      const h = open({ pages: [page([])] }, () => OK);
      show(h, RUNNER);
      const form = await screen.findByRole('form', { name: vi_['cap.scenario.form.title'] });
      fireEvent.change(within(form).getByLabelText(vi_['cap.scenario.field.code.label']), { target: { value: 'SC-NEW' } });
      await choose(vi_['cap.scenario.field.plan.label'], PUBLISHED_ID, form);
      await choose(vi_['cap.scenario.field.snapshot.label'], SNAPSHOT, form);
      fireEvent.change(within(form).getByLabelText(vi_['cap.scenario.field.min.label']), { target: { value: vnd(1) } });
      fireEvent.change(within(form).getByLabelText(vi_['cap.scenario.field.maxMove.label']), { target: { value: vnd(3) } });
      fireEvent.change(within(form).getByLabelText(vi_['cap.scenario.field.maxTotal.label']), { target: { value: vnd(4) } });
      await choose(vi_['cap.scenario.field.from.label'], planLine(1).id as string, form);
      await choose(vi_['cap.scenario.field.to.label'], PROJECT_B, form);
      fireEvent.change(within(form).getByLabelText(vi_['cap.scenario.field.amount.label']), { target: { value: vnd(2) } });
      fireEvent.change(within(form).getByLabelText(vi_['cap.scenario.field.note.label']), { target: { value: 'Behind the curve' } });
      fireEvent.click(within(form).getByRole('button', { name: vi_['cap.scenario.form.submit.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('createAllocationScenario');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({
        body: {
          code: 'SC-NEW',
          plan_year: 2025,
          base_capital_plan_id: PUBLISHED_ID,
          input_snapshot_id: SNAPSHOT,
          constraints: { min_remaining_vnd: vnd(1), max_move_vnd: vnd(3), max_total_vnd: vnd(4) },
          assumptions: { moves: [{ from_allocation_line_id: planLine(1).id, to_project_id: PROJECT_B, amount_vnd: vnd(2), rationale: 'Behind the curve' }] },
        },
      });
      expect((await screen.findByTestId('create-saved')).textContent).toBe(vi_['cap.scenario.form.saved']);
    });

    it('refuses before it sends what is missing, a move to the same project, an amount that is not whole dong and a limit that is not a number, and says in words what the server refuses', async () => {
      const h = open({ pages: [page([])] }, () => new ApiError({ status: 409, code: 'DUPLICATE_KEY', correlationId: 'c' }));
      show(h, RUNNER);
      const form = await screen.findByRole('form', { name: vi_['cap.scenario.form.title'] });
      fireEvent.click(within(form).getByRole('button', { name: vi_['cap.scenario.form.submit.action'] }));
      expect((await within(form).findAllByText(vi_['cap.scenario.field.required.error'])).length).toBeGreaterThanOrEqual(5);
      expect(h.command).not.toHaveBeenCalled();
      fireEvent.change(within(form).getByLabelText(vi_['cap.scenario.field.code.label']), { target: { value: 'SC-NEW' } });
      await choose(vi_['cap.scenario.field.plan.label'], PUBLISHED_ID, form);
      fireEvent.change(within(form).getByLabelText(vi_['cap.scenario.field.min.label']), { target: { value: 'many' } });
      await choose(vi_['cap.scenario.field.from.label'], planLine(1).id as string, form);
      await choose(vi_['cap.scenario.field.to.label'], PROJECT_A, form);
      fireEvent.change(within(form).getByLabelText(vi_['cap.scenario.field.amount.label']), { target: { value: '1.5' } });
      fireEvent.click(within(form).getByRole('button', { name: vi_['cap.scenario.form.submit.action'] }));
      expect(await within(form).findByText(vi_['cap.scenario.field.same.error'])).toBeTruthy();
      expect(within(form).getAllByText(vi_['cap.scenario.field.invalid.error'])).toHaveLength(2);
      expect(h.command).not.toHaveBeenCalled();
      fireEvent.change(within(form).getByLabelText(vi_['cap.scenario.field.min.label']), { target: { value: '' } });
      await choose(vi_['cap.scenario.field.to.label'], PROJECT_B, form);
      fireEvent.change(within(form).getByLabelText(vi_['cap.scenario.field.amount.label']), { target: { value: vnd(1) } });
      fireEvent.click(within(form).getByRole('button', { name: vi_['cap.scenario.form.submit.action'] }));
      expect((await within(form).findByTestId('create-refusal')).textContent).toBe(vi_['cap.scenario.problem.duplicate']);
    });

    it('adds and removes moves, and offers the form only to the person who may run scenarios, never in the read-only mode', async () => {
      const h = open({ pages: [page([])] });
      show(h, RUNNER);
      const form = await screen.findByRole('form', { name: vi_['cap.scenario.form.title'] });
      expect(within(form).getAllByTestId('scenario-move')).toHaveLength(1);
      expect(within(form).queryByRole('button', { name: vi_['cap.scenario.moves.remove.action'] })).toBeNull();
      fireEvent.click(within(form).getByRole('button', { name: vi_['cap.scenario.moves.add.action'] }));
      expect(within(form).getAllByTestId('scenario-move')).toHaveLength(2);
      fireEvent.click(within(form).getAllByRole('button', { name: vi_['cap.scenario.moves.remove.action'] })[0] as HTMLElement);
      expect(within(form).getAllByTestId('scenario-move')).toHaveLength(1);
      cleanup();
      show(open({ pages: [page([scenario(1)])] }), RUNNER, 'READ_ONLY');
      await screen.findByTestId('scenarios');
      expect(screen.queryByRole('form', { name: vi_['cap.scenario.form.title'] })).toBeNull();
      expect(screen.queryByRole('button', { name: vi_['cap.scenario.rerun.action'] })).toBeNull();
    });
  });

  describe('the model', () => {
    const form = (overrides: Partial<ScenarioForm> = {}): ScenarioForm => ({
      code: 'SC-1',
      planId: PUBLISHED_ID,
      snapshotId: '',
      minRemaining: '',
      maxMove: '',
      maxTotal: '',
      moves: [{ fromLineId: 'line-1', toProjectId: PROJECT_B, amount: '100', note: '' }],
      ...overrides,
    });
    const projectOf = (lineId: string): string | undefined => (lineId === 'line-1' ? PROJECT_A : undefined);

    it('judges the form: a code, a plan, optional limits as whole dong, and moves with a line, a different project and a positive whole amount, each pair once', () => {
      expect(validateForm(form(), projectOf)).toEqual({ moves: [{}] });
      expect(validateForm(form({ code: ' ' }), projectOf).code).toBe('required');
      expect(validateForm(form({ code: 'x'.repeat(51) }), projectOf).code).toBe('invalid');
      expect(validateForm(form({ planId: '' }), projectOf).planId).toBe('required');
      expect(validateForm(form({ minRemaining: '0' }), projectOf).minRemaining).toBeUndefined();
      expect(validateForm(form({ minRemaining: '-1', maxMove: '0', maxTotal: '1.5' }), projectOf)).toMatchObject({ minRemaining: 'invalid', maxMove: 'invalid', maxTotal: 'invalid' });
      const moves = [
        { fromLineId: '', toProjectId: '', amount: '', note: '' },
        { fromLineId: 'line-1', toProjectId: PROJECT_A, amount: '0', note: '' },
        { fromLineId: 'line-1', toProjectId: PROJECT_B, amount: '5', note: '' },
        { fromLineId: 'line-1', toProjectId: PROJECT_B, amount: '5', note: '' },
      ];
      expect(validateForm(form({ moves }), projectOf).moves).toEqual([
        { fromLineId: 'required', toProjectId: 'required', amount: 'required' },
        { toProjectId: 'same', amount: 'invalid' },
        {},
        { fromLineId: 'duplicate' },
      ]);
    });

    it('builds the body of the contract, leaving out the snapshot, the limits and the notes that were not given', () => {
      expect(scenarioBody(form(), { id: PUBLISHED_ID, planYear: 2025 })).toEqual({
        code: 'SC-1',
        plan_year: 2025,
        base_capital_plan_id: PUBLISHED_ID,
        constraints: {},
        assumptions: { moves: [{ from_allocation_line_id: 'line-1', to_project_id: PROJECT_B, amount_vnd: '100' }] },
      });
      expect(scenarioBody(form({ snapshotId: SNAPSHOT, minRemaining: '0', code: ' SC-1 ' }), { id: PUBLISHED_ID, planYear: 2025 })).toMatchObject({ input_snapshot_id: SNAPSHOT, constraints: { min_remaining_vnd: '0' }, code: 'SC-1' });
    });

    it('reads a page of scenarios and leaves out what is not one, and a result that is not a result', () => {
      const good = scenario(1);
      const parsed = toScenarioPage(page([good, { id: 'x' }, scenario(2, { result: { total_moved_vnd: 'x' }, status: 'DRAFT' }), scenario(3, { assumptions: { moves: [{ amount_vnd: 'x' }, {}] }, constraints: { max_move_vnd: vnd(1), max_total_vnd: vnd(2) } })], 'more'));
      expect(parsed.nextCursor).toBe('more');
      expect(parsed.items.map((item) => item.code)).toEqual(['SC-1', 'SC-2', 'SC-3']);
      expect(parsed.items[0]).toMatchObject({ planCode: 'KH-2025', scopeUnitName: 'Sở Tài chính', minRemainingVnd: vnd(1), mayRun: true, mayPromote: true });
      expect(parsed.items[0]?.moves).toEqual([{ fromAllocationLineId: planLine(1).id, toProjectId: PROJECT_B, amountVnd: vnd(2), note: 'Behind the curve' }]);
      expect(parsed.items[1]?.result).toBeNull();
      expect(parsed.items[2]).toMatchObject({ moves: [], maxMoveVnd: vnd(1), maxTotalVnd: vnd(2) });
      expect(toScenarioPage(null)).toEqual({ items: [], nextCursor: undefined });
      const odd = toScenarioPage(page([scenario(4, { result: { total_moved_vnd: '5', lines: [{}, { allocation_line_id: 'a' }], projects: [{}], ran_at: 7 }, actions: null, base_capital_plan: null, input_snapshot_id: null })]));
      expect(odd.items[0]).toMatchObject({ result: { totalMovedVnd: '5', lines: [], projects: [], ranAt: '' }, mayRun: false, snapshotId: null, planCode: '' });
    });

    it('tells what a project gains or loses as an exact number, who may act, and what the server refused', () => {
      expect(changeOf({ beforeVnd: '5', afterVnd: '3' })).toBe(-2n);
      expect(holds(undefined, 'x', 'FULL')).toBe(true);
      expect(holds(['x'], 'x', 'READ_ONLY')).toBe(false);
      expect(holds(['y'], 'x', 'FULL')).toBe(false);
      const refused = (code: string) => describeScenario(new ApiError({ status: 422, code, correlationId: 'c' }));
      expect(['SCENARIO_CONSTRAINT_INFEASIBLE', 'SCENARIO_NOT_RUN', 'SNAPSHOT_NOT_FROZEN', 'REVISED_BELOW_COMMITTED', 'PLAN_NOT_PUBLISHED', 'VERSION_CONFLICT', 'STAGE_TRANSITION_DENIED', 'DUPLICATE_KEY', 'SCOPE_DENIED', 'VALIDATION_FAILED', 'INVALID_REQUEST', 'RESOURCE_NOT_FOUND', 'OTHER'].map(refused)).toEqual([
        'infeasible',
        'notRun',
        'snapshotNotFrozen',
        'belowCommitted',
        'planNotPublished',
        'versionConflict',
        'stageDenied',
        'duplicate',
        'scopeDenied',
        'validation',
        'validation',
        'notFound',
        'general',
      ]);
      expect(describeScenario(new Error('x'))).toBe('general');
      expect(violationsOf(new Error('x'))).toEqual([]);
      expect(violationsOf(new ApiError({ status: 422, code: 'X', correlationId: 'c', extensions: { violations: 'x' } }))).toEqual([]);
      expect(violationsOf(new ApiError({ status: 422, code: 'X', correlationId: 'c', extensions: { violations: [{ kind: 'A' }, {}, 5] } }))).toEqual(['A']);
    });
  });
});
