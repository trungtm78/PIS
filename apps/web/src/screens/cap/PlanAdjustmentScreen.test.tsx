import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { EditionProvider } from '../../editions/EditionContext';
import { PUBLIC_BUNDLE } from '../../editions/edition';
import type { WebEditionBundle } from '../../editions/edition';
import vi_ from '../../i18n/vi.json';
import PlanAdjustmentScreen from './PlanAdjustmentScreen';
import { ANNUAL_ID, BILLION, PUBLISHED_ID, mount, plan, planClient, planLine, planWorld, routeOf } from './plan-test-support';
import type { PlanWorld } from './plan-test-support';

const ROUTE = routeOf('CAP-07', 'FR-CAP-07');
const PLANNER = ['capital.read', 'plan_version.read', 'capital.plan.draft'];
const READER = ['capital.read', 'plan_version.read'];
const DECISION = '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';
const REASON = 'The ceiling of DA-01 moved after the review of the decision';
const vnd = (billions: number): string => String(billions * BILLION);
const problem = (code: string, status = 409) => new ApiError({ status, code, correlationId: 'c', extensions: {} });
const answer = { operation_id: 'o', status: 'DRAFT', resource_version: 1, resource_id: ANNUAL_ID };

afterEach(cleanup);

/** The published plan (PUBLISHED_ID, DA-01 5 billion, DA-02 1 billion) and, when asked for, the revision made from it (ANNUAL_ID) with the capital moved. */
function world(options: { revision?: 'DRAFT' | 'IN_REVIEW' | 'none'; moved?: string } = {}): PlanWorld {
  const base = planWorld();
  const published = plan(PUBLISHED_ID, { status: 'PUBLISHED', revision: 1, version: 9, decision_document: { id: DECISION, symbol: '12/QD-UBND', issued_on: '2026-01-15' } });
  const revision = options.revision ?? 'none';
  const moved = options.moved ?? String(0.8 * BILLION);
  return {
    ...base,
    plans: revision === 'none' ? [published] : [plan(ANNUAL_ID, { status: revision, revision: 2, supersedes_id: PUBLISHED_ID, version: 3 }), published],
    lines: {
      [PUBLISHED_ID]: [
        planLine(1, { capital_plan_id: PUBLISHED_ID, plan_status: 'PUBLISHED', amount_vnd: vnd(5) }),
        planLine(2, { capital_plan_id: PUBLISHED_ID, plan_status: 'PUBLISHED', amount_vnd: vnd(1) }),
      ],
      [ANNUAL_ID]: [
        planLine(1, { amount_vnd: (BigInt(vnd(5)) - BigInt(moved)).toString() }),
        planLine(2, { amount_vnd: (BigInt(vnd(1)) + BigInt(moved)).toString() }),
      ],
    },
  };
}

const open = (state: PlanWorld, permissions: readonly string[], command?: (operation: string, input: unknown) => unknown, options: { mode?: 'READ_ONLY'; path?: string } = {}) => {
  const h = planClient(state, command);
  mount(<PlanAdjustmentScreen route={ROUTE} />, h, { permissions, path: options.path ?? '/', ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return h;
};
const ready = () => waitFor(() => expect(screen.getByTestId('plan-header')).toBeTruthy());
const headerPlan = (): string | null => screen.getByTestId('plan-header').getAttribute('data-plan-id');

describe('PlanAdjustmentScreen (CAP-07): the adjustment and transfer of a capital plan', () => {
  it('opens on the plan in force and asks for a reason of at least 10 characters before it makes a revision (AC-ST-CAP-004-2)', async () => {
    const h = open(world(), PLANNER, () => answer);
    await ready();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['cap.adjustment.page.title']);
    expect(headerPlan()).toBe(PUBLISHED_ID);
    fireEvent.click(screen.getByRole('button', { name: vi_['cap.adjustment.revise.action'] }));
    expect(screen.getByText(vi_['cap.adjustment.reason.required.error'])).toBeTruthy();
    fireEvent.change(screen.getByLabelText(vi_['cap.adjustment.reason.label']), { target: { value: 'too short' } });
    fireEvent.click(screen.getByRole('button', { name: vi_['cap.adjustment.revise.action'] }));
    expect(screen.getByText(vi_['cap.adjustment.reason.tooShort.error'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(vi_['cap.adjustment.reason.label']), { target: { value: `  ${REASON}  ` } });
    fireEvent.click(screen.getByRole('button', { name: vi_['cap.adjustment.revise.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    const [operation, input] = h.command.mock.calls[0] as [string, { path: { id: string }; ifMatchVersion: number; body: unknown }];
    expect(operation).toBe('createCapitalPlanRevision');
    expect(input).toMatchObject({ path: { id: PUBLISHED_ID }, ifMatchVersion: 9, body: { reason: REASON } });
    await waitFor(() => expect(screen.getByTestId('created')).toBeTruthy());
    expect(screen.getByTestId('created').textContent).toContain(vi_['cap.adjustment.revise.done']);
  });

  it('keeps the notice of the revision it just made when the list is read again and shows that revision as the one in work', async () => {
    const state = world();
    const h = open(state, PLANNER, () => {
      // The command wrote the revision: the next read of the plans holds it.
      state.plans = [plan(ANNUAL_ID, { status: 'DRAFT', revision: 2, supersedes_id: PUBLISHED_ID, version: 1 }), ...state.plans];
      state.lines[ANNUAL_ID] = state.lines[PUBLISHED_ID] ?? [];
      return answer;
    });
    await ready();
    fireEvent.change(screen.getByLabelText(vi_['cap.adjustment.reason.label']), { target: { value: REASON } });
    fireEvent.click(screen.getByRole('button', { name: vi_['cap.adjustment.revise.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId('revise-state').getAttribute('data-state')).toBe('pending'));
    expect(screen.getByTestId('created').textContent).toBe(vi_['cap.adjustment.revise.done']);
    expect(screen.queryByRole('button', { name: vi_['cap.adjustment.revise.action'] })).toBeNull();
  });

  it('says why a second revision cannot be made while one is in work, and opens that one', async () => {
    open(world({ revision: 'DRAFT' }), PLANNER, undefined, { path: `/?plan=${PUBLISHED_ID}` });
    await ready();
    expect(headerPlan()).toBe(PUBLISHED_ID);
    const state = screen.getByTestId('revise-state');
    expect(state.getAttribute('data-state')).toBe('pending');
    expect(state.textContent).toContain('CP-2026');
    expect(screen.queryByRole('button', { name: vi_['cap.adjustment.revise.action'] })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: vi_['cap.adjustment.pending.open'] }));
    await waitFor(() => expect(headerPlan()).toBe(ANNUAL_ID));
  });

  it('shows the capital a revision moves: the sources that go down beside the sources that go up, the same total on both sides (AC-ST-CAP-004-2)', async () => {
    open(world({ revision: 'DRAFT' }), PLANNER, undefined, { path: `/?plan=${ANNUAL_ID}` });
    await waitFor(() => expect(screen.getByTestId('transfer')).toBeTruthy());
    expect(screen.getByTestId('transfer').textContent).toContain('CP-2026 phiên bản 1');
    const down = screen.getByTestId('side-down');
    const up = screen.getByTestId('side-up');
    expect(within(down).getAllByRole('row').some((row) => row.textContent?.includes('DA-01'))).toBe(true);
    expect(within(down).getByTestId('value').textContent).toBe('800');
    expect(within(up).getAllByRole('row').some((row) => row.textContent?.includes('DA-02'))).toBe(true);
    expect(within(up).getByTestId('value').textContent).toBe('800');
    expect(within(down).getByTestId('side-total').textContent).toBe('800');
    expect(within(up).getByTestId('side-total').textContent).toBe('800');
    expect(screen.getByTestId('balance').getAttribute('data-balanced')).toBe('true');
    // The basis of the capital given up is the decision in force; the revision has no decision yet.
    expect(down.textContent).toContain('12/QD-UBND');
    expect(up.textContent).toContain(vi_['cap.planHeader.noDecision.notice']);
  });

  it('flags a revision that changes the total, and says when nothing is changed yet', async () => {
    const state = world({ revision: 'IN_REVIEW' });
    state.lines[ANNUAL_ID] = [planLine(1, { amount_vnd: vnd(5) }), planLine(2, { amount_vnd: vnd(3) })];
    open(state, READER, undefined, { path: `/?plan=${ANNUAL_ID}` });
    await waitFor(() => expect(screen.getByTestId('balance')).toBeTruthy());
    expect(screen.getByTestId('balance').getAttribute('data-balanced')).toBe('false');
    expect(screen.getByTestId('side-down').getAttribute('data-empty')).toBe('true');
    cleanup();

    const unchanged = world({ revision: 'DRAFT', moved: '0' });
    open(unchanged, READER, undefined, { path: `/?plan=${ANNUAL_ID}` });
    await waitFor(() => expect(screen.getByTestId('transfer-none')).toBeTruthy());
  });

  it('offers a revision of the plan in force only to those who may draft plans, and says so to the others and to a frozen tenant', async () => {
    open(world(), READER);
    await ready();
    expect(screen.getByTestId('revise-state').getAttribute('data-state')).toBe('denied');
    expect(screen.getByTestId('revise-state').textContent).toBe(vi_['cap.adjustment.denied.notice']);
    expect(screen.queryByRole('button', { name: vi_['cap.adjustment.revise.action'] })).toBeNull();
    cleanup();

    open(world(), PLANNER, undefined, { mode: 'READ_ONLY' });
    await ready();
    expect(screen.getByTestId('revise-state').textContent).toBe(vi_['cap.readOnly.frozen.notice']);
  });

  it('says that only the plan in force can be revised when the plan is not published', async () => {
    const state = world({ revision: 'DRAFT' });
    open(state, PLANNER, undefined, { path: `/?plan=${ANNUAL_ID}` });
    await ready();
    expect(screen.getByTestId('revise-state').getAttribute('data-state')).toBe('not-published');
  });

  it.each([
    ['REVISION_PENDING_EXISTS', 'pending'],
    ['PLAN_NOT_PUBLISHED', 'notPublished'],
    ['VERSION_CONFLICT', 'versionConflict'],
    ['FISCAL_YEAR_LOCKED', 'yearLocked'],
    ['SCOPE_DENIED', 'denied'],
  ])('tells what the server refused with %s', async (code, kind) => {
    open(world(), PLANNER, () => problem(code, code === 'SCOPE_DENIED' ? 403 : 409));
    await ready();
    fireEvent.change(screen.getByLabelText(vi_['cap.adjustment.reason.label']), { target: { value: REASON } });
    fireEvent.click(screen.getByRole('button', { name: vi_['cap.adjustment.revise.action'] }));
    await waitFor(() => expect(screen.getByTestId('problem')).toBeTruthy());
    expect(screen.getByTestId('problem').getAttribute('data-problem')).toBe(kind);
    expect(screen.queryByTestId('created')).toBeNull();
  });
});

// The enterprise edition names the source that moves in words, not by its code (CAP-07 on the demo of Đạm Phú Mỹ).
const ENTERPRISE = { manifest: { ...PUBLIC_BUNDLE.manifest, edition: 'enterprise' } } as unknown as WebEditionBundle;

describe('PlanAdjustmentScreen (CAP-07) in the enterprise edition', () => {
  const sourceOf = async (edition: WebEditionBundle): Promise<string> => {
    mount(
      <EditionProvider edition={edition}>
        <PlanAdjustmentScreen route={ROUTE} />
      </EditionProvider>,
      planClient(world({ revision: 'DRAFT' })),
      { permissions: PLANNER, path: `/?plan=${ANNUAL_ID}` },
    );
    await waitFor(() => expect(screen.getByTestId('transfer')).toBeTruthy());
    return within(screen.getByTestId('side-down')).getAllByRole('row')[1]?.textContent ?? '';
  };

  it('shows the name of the source where the public edition shows its code', async () => {
    const row = await sourceOf(ENTERPRISE);
    expect(row).toContain('Ngân sách trung ương');
    expect(row).not.toContain('NSTW-DTPT');
  });

  it('shows the code of the source on the public edition', async () => {
    expect(await sourceOf(PUBLIC_BUNDLE)).toContain('NSTW-DTPT');
  });
});
