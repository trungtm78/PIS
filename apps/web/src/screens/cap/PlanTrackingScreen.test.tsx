import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import PlanTrackingScreen from './PlanTrackingScreen';
import { ANNUAL_ID, BILLION, PUBLISHED_ID, mount, plan, planClient, planLine, planWorld, routeOf } from './plan-test-support';
import type { PlanWorld } from './plan-test-support';

const ROUTE = routeOf('CAP-15', 'FR-CAP-15');
const READER = ['capital.read', 'plan_version.read'];
const FIRST = '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';
const SECOND = '4a3c9d2f-5e6b-4c7d-9e8f-0a1b2c3d4e5f';
const vnd = (billions: number): string => String(billions * BILLION);
const notFound = () => new ApiError({ status: 404, code: 'RESOURCE_NOT_FOUND', correlationId: 'c', extensions: {} });

afterEach(cleanup);

const asOfLine = (n: number, current: string, initial: string, disbursed: string, planId: string) => {
  const adjustment = (BigInt(current) - BigInt(initial)).toString();
  return { ...planLine(n, { capital_plan_id: planId, plan_status: 'PUBLISHED', amount_vnd: current }), initial_vnd: initial, adjustment_vnd: adjustment, as_of_disbursed_vnd: disbursed };
};

/** Revision 1 (30/6): DA-01 5 billion. Revision 2 (from 1/7): DA-01 4.2 billion and DA-02 0.8 billion. Revision 2 replaced revision 1. */
function world(): PlanWorld {
  const base = planWorld();
  const first = { id: FIRST, symbol: '12/QD-UBND', issued_on: '2026-01-10' };
  const second = { id: SECOND, symbol: '88/QD-UBND', issued_on: '2026-06-28' };
  return {
    ...base,
    plans: [
      plan(ANNUAL_ID, { status: 'PUBLISHED', revision: 2, supersedes_id: PUBLISHED_ID, version: 7, effective_at: '2026-07-01T00:00:00.000Z', decision_document: second }),
      plan(PUBLISHED_ID, { status: 'SUPERSEDED', revision: 1, version: 9, effective_at: '2026-01-15T00:00:00.000Z', decision_document: first }),
    ],
    asOf: ({ id, at }) => {
      const before = at !== undefined && at < '2026-07-01';
      if (at !== undefined && at < '2026-01-15') return notFound();
      const revisionId = before ? PUBLISHED_ID : ANNUAL_ID;
      return {
        capital_plan_id: revisionId,
        plan_code: 'CP-2026',
        revision: before ? 1 : 2,
        status: before ? 'SUPERSEDED' : 'PUBLISHED',
        decision_document_id: before ? FIRST : SECOND,
        effective_at: before ? '2026-01-15T00:00:00.000Z' : '2026-07-01T00:00:00.000Z',
        as_of: at === undefined ? '2026-10-25T00:00:00.000Z' : `${at}T16:59:59.999Z`,
        truncated: id === 'truncated',
        totals: before
          ? { amount_vnd: vnd(5), initial_vnd: vnd(5), adjustment_vnd: '0', disbursed_vnd: vnd(1) }
          : { amount_vnd: vnd(5), initial_vnd: vnd(5), adjustment_vnd: '0', disbursed_vnd: vnd(2) },
        lines: before
          ? [asOfLine(1, vnd(5), vnd(5), vnd(1), revisionId)]
          : [asOfLine(1, String(4.2 * BILLION), vnd(5), vnd(2), revisionId), asOfLine(2, String(0.8 * BILLION), '0', '0', revisionId)],
      };
    },
  };
}

const open = (state: PlanWorld, path = '/') => {
  const h = planClient(state);
  mount(<PlanTrackingScreen route={ROUTE} />, h, { permissions: READER, path });
  return h;
};
const ready = () => waitFor(() => expect(screen.getByTestId('tracking')).toBeTruthy());
const chooseDay = (day: string) => fireEvent.change(screen.getByLabelText(vi_['cap.tracking.date.label']), { target: { value: day } });
const rowOf = (code: string): HTMLElement => Array.from(document.querySelectorAll<HTMLElement>('tbody tr')).find((row) => row.textContent?.includes(code)) as HTMLElement;

describe('PlanTrackingScreen (CAP-15): the tracking of a capital plan', () => {
  it('opens on the plan in force now and compares initial, adjustment, current and disbursed with the decision behind it (UI-CAP-15, AC-ST-CAP-004-2)', async () => {
    const h = open(world());
    await ready();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['cap.tracking.page.title']);
    expect(screen.getByTestId('tracking').getAttribute('data-revision')).toBe('2');
    expect(h.read).toHaveBeenCalledWith('getCapitalPlanAsOf', { path: { id: ANNUAL_ID }, query: {} });
    // DA-01 was given 5 billion first and reduced by 0.8; DA-02 was added with the 0.8; the total did not move.
    const first = rowOf('DA-01');
    expect(within(first).getByTestId('initial').textContent).toBe('5.000');
    expect(within(first).getByTestId('adjustment').textContent).toBe('-800');
    expect(within(first).getByTestId('current').textContent).toBe('4.200');
    expect(within(first).getByTestId('disbursed').textContent).toBe('2.000');
    expect(within(first).getByTestId('decision').textContent).toContain('88/QD-UBND');
    const second = rowOf('DA-02');
    expect(within(second).getByTestId('initial').textContent).toBe('0');
    expect(within(second).getByTestId('adjustment').textContent).toBe('800');
    expect(within(second).getByTestId('current').textContent).toBe('800');
    expect(screen.getByTestId('total-initial').textContent).toBe('5.000');
    expect(screen.getByTestId('total-adjustment').textContent).toBe('0');
    expect(screen.getByTestId('total-current').textContent).toBe('5.000');
  });

  it('reads the plan as of a day: 30/6 gives the first revision with its decision, 2/7 the second (AC-ST-CAP-004-1)', async () => {
    const h = open(world());
    await ready();
    chooseDay('2026-06-30');
    await waitFor(() => expect(screen.getByTestId('tracking').getAttribute('data-revision')).toBe('1'));
    expect(h.read).toHaveBeenCalledWith('getCapitalPlanAsOf', { path: { id: ANNUAL_ID }, query: { at: '2026-06-30' } });
    expect(within(rowOf('DA-01')).getByTestId('current').textContent).toBe('5.000');
    expect(within(rowOf('DA-01')).getByTestId('decision').textContent).toContain('12/QD-UBND');
    expect(document.querySelectorAll('tbody tr')).toHaveLength(1);
    chooseDay('2026-07-02');
    await waitFor(() => expect(screen.getByTestId('tracking').getAttribute('data-revision')).toBe('2'));
    expect(within(rowOf('DA-01')).getByTestId('current').textContent).toBe('4.200');
    expect(within(rowOf('DA-01')).getByTestId('decision').textContent).toContain('88/QD-UBND');
    // Back to an empty day: the plan as it stands now.
    chooseDay('');
    await waitFor(() => expect(h.read).toHaveBeenLastCalledWith('getCapitalPlanAsOf', { path: { id: ANNUAL_ID }, query: {} }));
  });

  it('says that no revision was in force before the first one, without calling it an error', async () => {
    open(world());
    await ready();
    chooseDay('2025-12-31');
    await waitFor(() => expect(screen.getByTestId('nothing')).toBeTruthy());
    expect(screen.getByTestId('nothing').textContent).toBe(vi_['cap.tracking.none.notice']);
    expect(screen.queryByTestId('tracking')).toBeNull();
    // The day stays editable: a later day brings the plan back.
    chooseDay('2026-07-02');
    await ready();
  });

  it('follows a revision named in the address to the plan it belongs to', async () => {
    const h = open(world(), `/?plan=${PUBLISHED_ID}`);
    await ready();
    expect(h.read).toHaveBeenCalledWith('getCapitalPlanAsOf', { path: { id: ANNUAL_ID }, query: {} });
    expect((screen.getByLabelText(vi_['cap.planChooser.label']) as HTMLSelectElement).value).toBe(ANNUAL_ID);
  });

  it('says so when the lines shown are only some of the plan', async () => {
    const state = world();
    const original = state.asOf;
    state.asOf = (input) => ({ ...(original?.(input) as Record<string, unknown>), truncated: true });
    open(state);
    await ready();
    expect(screen.getByTestId('truncated').textContent).toBe(vi_['cap.tracking.truncated.notice']);
  });

  it('shows the empty state when no plan was ever published', async () => {
    const state = world();
    state.plans = [plan(ANNUAL_ID, { status: 'DRAFT', version: 1 })];
    open(state);
    await waitFor(() => expect(screen.getByText(vi_['states.empty.title'])).toBeTruthy());
    expect(screen.queryByTestId('tracking')).toBeNull();
    expect(screen.queryByLabelText(vi_['cap.tracking.date.label'])).toBeNull();
  });

  it('shows a failure of the read as an error with a way to retry', async () => {
    const state = world();
    state.asOf = () => new ApiError({ status: 500, code: 'INTERNAL', correlationId: 'c', extensions: {} });
    open(state);
    await waitFor(() => expect(screen.getByText(vi_['states.error.title'])).toBeTruthy());
  });
});
