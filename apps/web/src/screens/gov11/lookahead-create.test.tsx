import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebRoute } from '../../routes/types';
import { harness, mount } from '../sas/test-support';
import LookAheadScreen from './LookAheadScreen';

const route: WebRoute = { id: 'PRJ-30', path: '/prj/prj-30', title: 'PRJ-30', kind: 'table', area: 'investment', module: 'PRJ', group: 'PRJ', role: 'workspace', parent: null, req: 'FR-PRJ-30' };
const WRITE = ['look_ahead.write'];
const ID = '00000000-0000-4000-8000-0000000000f1';
const EXISTING = '00000000-0000-4000-8000-0000000000f2';
const NEW_PLAN = '00000000-0000-4000-8000-0000000000f3';
const MEMBER = '00000000-0000-4000-8000-0000000000e1';
const AS_OF = '2026-11-08T03:00:00.000Z';
const rule = { code: 'DEFAULT', version: 0, source: 'DEFAULT', unverified: true, params: { min_weeks: 2, max_weeks: 6, default_weeks: 3, constraint_kinds: ['DESIGN', 'MATERIAL', 'OTHER'], variance_reasons: ['WEATHER', 'OTHER'] }, provenance: { formula: 'A formula in words', source: 'The research', as_of: '2026-11-08', legal_status: 'UNVERIFIED' } };
const item = (n: number, over: Record<string, unknown> = {}) => ({ id: `i${n}`, sequence: n, description: `Item ${n}`, planned_start: '2026-11-10', planned_finish: '2026-11-12', responsible: 'Crew', outcome: 'PLANNED', variance_reason_code: null, outcome_at: null, state: 'READY', constraints: [], version: 1, ...over });
const emptyView = (over: Record<string, unknown> = {}) => ({ project: { id: ID, code: 'DA1', name: 'P', status: 'IMPLEMENTATION' }, plan: null, history: [], overdue: false, rule, as_of: AS_OF, ...over });
const planOf = (items: unknown[], over: Record<string, unknown> = {}) => ({ id: 'pl', project_id: ID, week_start: '2026-11-02', window_end: '2026-11-23', horizon_weeks: 3, status: 'DRAFT', policy_version: 0, published_at: null, items, ppc: { committed: 0, done: 0, pct: null, band: 'NO_DATA' }, version: 1, ...over });
const planView = (items: unknown[], over: Record<string, unknown> = {}) =>
  emptyView({
    plan: planOf(items),
    history: [
      { id: 'pl', week_start: '2026-11-02', horizon_weeks: 3, status: 'DRAFT', ppc: { pct: null, band: 'NO_DATA' } },
      { id: EXISTING, week_start: '2026-10-26', horizon_weeks: 3, status: 'PUBLISHED', ppc: { pct: '80.0', band: 'ON_TARGET' } },
    ],
    ...over,
  });
const problem = (status: number, code: string, extensions?: Record<string, unknown>) => new ApiError({ status, code, correlationId: 'c', ...(extensions === undefined ? {} : { extensions }) });
const mountAt = (h: ReturnType<typeof harness>, permissions: readonly string[] = WRITE) => mount(<LookAheadScreen route={route} />, h, permissions, `/prj/prj-30?id=${ID}`);
const type = (testId: string, value: string) => fireEvent.change(screen.getByTestId(testId), { target: { value } });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('PRJ-30 creating the look-ahead plan', () => {
  it('shows an empty state with the action that creates the first plan, and the default Monday of the week of the read', async () => {
    mountAt(harness(() => emptyView()));
    expect(await screen.findByTestId('no-plan')).toBeTruthy();
    fireEvent.click(screen.getByTestId('new-plan'));
    expect((screen.getByTestId('week-start') as HTMLInputElement).value).toBe('2026-11-02');
    expect((screen.getByTestId('horizon') as HTMLSelectElement).value).toBe('3');
    expect(Array.from((screen.getByTestId('horizon') as HTMLSelectElement).options).map((option) => option.value)).toEqual(['2', '3', '4', '5', '6']);
    expect(screen.getByTestId('window-preview').textContent).toContain('02/11/2026');
    expect(screen.getByTestId('window-preview').textContent).toContain('23/11/2026');
    expect(within(screen.getByTestId('plan-form')).getAllByRole('button').some((button) => button.className.includes('ui-info'))).toBe(true);
  });

  it('sends the plan once with the typed items, then opens the plan the server made and says it is a draft', async () => {
    const h = harness(
      (_operation, input) => ((input as { query?: { plan_id?: string } }).query?.plan_id === NEW_PLAN ? planView([item(1, { description: 'Pour the slab' })], { plan: planOf([item(1, { description: 'Pour the slab' })], { id: NEW_PLAN }) }) : emptyView()),
      () => ({ operation_id: 'o', status: 'DRAFT', resource_version: 1, resource_id: NEW_PLAN }),
    );
    mountAt(h);
    fireEvent.click(await screen.findByTestId('new-plan'));
    type('desc-1', '  Pour the slab ');
    type('start-1', '2026-11-03');
    type('finish-1', '2026-11-05');
    type('resp-1', 'Crew A');
    fireEvent.click(screen.getByTestId('add-row'));
    type('desc-2', 'Cure');
    type('start-2', '2026-11-06');
    type('finish-2', '2026-11-06');
    fireEvent.submit(screen.getByTestId('plan-form'));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command).toHaveBeenCalledWith(
      'createLookAheadPlan',
      expect.objectContaining({
        path: { id: ID },
        body: {
          week_start: '2026-11-02',
          horizon_weeks: 3,
          items: [
            { description: 'Pour the slab', planned_start: '2026-11-03', planned_finish: '2026-11-05', responsible: 'Crew A' },
            { description: 'Cure', planned_start: '2026-11-06', planned_finish: '2026-11-06' },
          ],
        },
      }),
    );
    expect(await screen.findByTestId('created-receipt')).toBeTruthy();
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('getLookAhead', expect.objectContaining({ query: { plan_id: NEW_PLAN } })));
    expect(await screen.findByTestId('item-1')).toBeTruthy();
    expect(screen.getByTestId('publish')).toBeTruthy();
  });

  it('refuses to send a form with problems, marks each field, and sends nothing', async () => {
    const h = harness(() => emptyView());
    mountAt(h);
    fireEvent.click(await screen.findByTestId('new-plan'));
    fireEvent.submit(screen.getByTestId('plan-form'));
    expect(await screen.findByTestId('form-summary')).toBeTruthy();
    expect(screen.getByTestId('desc-1').getAttribute('aria-invalid')).toBe('true');
    type('desc-1', 'Pour');
    type('start-1', '2026-11-12');
    type('finish-1', '2026-11-03');
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(1);
    type('week-start', '2026-11-03');
    expect(screen.getByTestId('week-error').textContent).not.toBe('');
    fireEvent.submit(screen.getByTestId('plan-form'));
    expect(h.command).not.toHaveBeenCalled();
  });

  it('says first that a week already has a plan, and sends nothing for it', async () => {
    const h = harness(() => planView([item(1)]));
    mountAt(h);
    fireEvent.click(await screen.findByTestId('new-plan'));
    // the Monday of the week of the read is covered, so the form starts on the next free one
    expect((screen.getByTestId('week-start') as HTMLInputElement).value).toBe('2026-11-09');
    type('week-start', '2026-11-02');
    expect(screen.getByTestId('week-error').textContent).toContain('02/11/2026');
    type('desc-1', 'Pour the slab');
    type('start-1', '2026-11-03');
    type('finish-1', '2026-11-03');
    fireEvent.submit(screen.getByTestId('plan-form'));
    expect(h.command).not.toHaveBeenCalled();
  });

  it('keeps what was typed when the server refuses, and links to the plan that already exists', async () => {
    const h = harness(
      (_operation, input) => ((input as { query?: { plan_id?: string } }).query?.plan_id === EXISTING ? planView([item(1)]) : emptyView()),
      () => problem(409, 'LOOK_AHEAD_PLAN_EXISTS', { plan_id: EXISTING }),
    );
    mountAt(h);
    fireEvent.click(await screen.findByTestId('new-plan'));
    type('desc-1', 'Pour the slab');
    type('start-1', '2026-11-03');
    type('finish-1', '2026-11-03');
    fireEvent.submit(screen.getByTestId('plan-form'));
    expect(await screen.findByTestId('create-error')).toBeTruthy();
    expect((screen.getByTestId('desc-1') as HTMLInputElement).value).toBe('Pour the slab');
    fireEvent.click(screen.getByTestId('open-existing'));
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('getLookAhead', expect.objectContaining({ query: { plan_id: EXISTING } })));
  });

  it('shows other refusals in words and keeps the form', async () => {
    const h = harness(() => emptyView(), () => problem(422, 'LOOK_AHEAD_WINDOW_INVALID'));
    mountAt(h);
    fireEvent.click(await screen.findByTestId('new-plan'));
    type('desc-1', 'Pour the slab');
    type('start-1', '2026-11-03');
    type('finish-1', '2026-11-03');
    fireEvent.submit(screen.getByTestId('plan-form'));
    expect((await screen.findByTestId('create-error')).textContent).not.toBe('');
    expect(screen.queryByTestId('open-existing')).toBeNull();
    expect(screen.getByTestId('plan-form')).toBeTruthy();
  });

  it('adds pasted lines as rows and removes a row', async () => {
    mountAt(harness(() => emptyView()));
    fireEvent.click(await screen.findByTestId('new-plan'));
    fireEvent.change(screen.getByTestId('paste-box'), { target: { value: 'Pour the slab;2026-11-03;2026-11-05;Crew A\nCure;2026-11-06' } });
    fireEvent.click(screen.getByTestId('paste-add'));
    expect((screen.getByTestId('desc-3') as HTMLInputElement).value).toBe('Cure');
    expect((screen.getByTestId('finish-3') as HTMLInputElement).value).toBe('2026-11-06');
    fireEvent.click(screen.getByTestId('remove-1'));
    expect((screen.getByTestId('desc-1') as HTMLInputElement).value).toBe('Pour the slab');
    expect(screen.getByTestId('window-preview').textContent).toContain('2');
  });

  it('closes the form on cancel without sending, and offers it again', async () => {
    const h = harness(() => emptyView());
    mountAt(h);
    fireEvent.click(await screen.findByTestId('new-plan'));
    fireEvent.click(screen.getByTestId('cancel-plan'));
    expect(screen.queryByTestId('plan-form')).toBeNull();
    expect(screen.getByTestId('new-plan')).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('offers no form to a person without the right, and says why', async () => {
    mountAt(harness(() => emptyView()), ['capital.read']);
    expect(await screen.findByTestId('no-create')).toBeTruthy();
    expect(screen.queryByTestId('new-plan')).toBeNull();
  });

  it('offers a new week next to a plan that exists, and opens another week from the list', async () => {
    const h = harness(() => planView([item(1)]));
    mountAt(h);
    expect(await screen.findByTestId('new-plan')).toBeTruthy();
    expect(screen.queryByTestId(`open-pl`)).toBeNull();
    fireEvent.click(screen.getByTestId(`open-${EXISTING}`));
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('getLookAhead', expect.objectContaining({ query: { plan_id: EXISTING } })));
  });

  it('shows a read that failed with a retry, not an empty plan', async () => {
    let calls = 0;
    const h = harness(() => (calls++ === 0 ? problem(500, 'INTERNAL') : emptyView()));
    mountAt(h);
    const retry = await screen.findByRole('button', { name: /thử lại|try again|retry/i });
    expect(screen.queryByTestId('no-plan')).toBeNull();
    fireEvent.click(retry);
    expect(await screen.findByTestId('no-plan')).toBeTruthy();
  });
});

describe('PRJ-30 raising a constraint', () => {
  const answer = () => planView([item(1), item(2, { outcome: 'DONE', state: 'DONE' })], { plan: planOf([item(1), item(2, { outcome: 'DONE', state: 'DONE' })], { status: 'PUBLISHED' }) });
  const withMembers = (h: ReturnType<typeof harness>, rows: unknown[] | Error) => {
    (h.client as unknown as { readAll: unknown }).readAll = vi.fn(() => (rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows)));
  };

  it('is offered only on an item that is not recorded, and only to a person who may write', async () => {
    mountAt(harness(answer));
    await screen.findByTestId('item-1');
    expect(screen.getByTestId('raise-1')).toBeTruthy();
    expect(screen.queryByTestId('raise-2')).toBeNull();
    cleanup();
    mountAt(harness(answer), ['capital.read']);
    await screen.findByTestId('item-1');
    expect(screen.queryByTestId('raise-1')).toBeNull();
  });

  it('sends the kind, the words, the owner and the day under the item, then says it was recorded', async () => {
    const h = harness(answer, () => ({ operation_id: 'o', status: 'OPEN', resource_version: 1, resource_id: 'k9' }));
    withMembers(h, [{ id: MEMBER, display_name: 'An Nguyen' }, { id: 'x', display_name: '' }]);
    mountAt(h);
    fireEvent.click(await screen.findByTestId('raise-1'));
    await waitFor(() => expect(within(screen.getByTestId('constraint-owner')).getByText('An Nguyen')).toBeTruthy());
    expect(Array.from((screen.getByTestId('constraint-kind') as HTMLSelectElement).options).map((option) => option.value)).toEqual(['DESIGN', 'MATERIAL', 'OTHER']);
    fireEvent.change(screen.getByTestId('constraint-kind'), { target: { value: 'MATERIAL' } });
    type('constraint-description', ' Rebar not delivered ');
    fireEvent.change(screen.getByTestId('constraint-owner'), { target: { value: MEMBER } });
    type('constraint-due', '2026-11-12');
    expect(screen.getByTestId('due-late')).toBeTruthy();
    fireEvent.submit(screen.getByTestId('constraint-form'));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('raiseLookAheadConstraint', expect.objectContaining({ path: { id: 'i1' }, body: { kind: 'MATERIAL', description: 'Rebar not delivered', owner_membership_id: MEMBER, due_on: '2026-11-12' } })));
    expect(await screen.findByTestId('receipt')).toBeTruthy();
    expect(screen.queryByTestId('constraint-form')).toBeNull();
  });

  it('refuses short words before sending, and shows a refusal of the server without closing the form', async () => {
    const h = harness(answer, () => problem(409, 'LOOK_AHEAD_STATE_INVALID'));
    withMembers(h, []);
    mountAt(h);
    fireEvent.click(await screen.findByTestId('raise-1'));
    fireEvent.submit(screen.getByTestId('constraint-form'));
    expect(h.command).not.toHaveBeenCalled();
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
    type('constraint-description', 'Rebar not delivered');
    fireEvent.submit(screen.getByTestId('constraint-form'));
    expect(await screen.findByTestId('raise-error')).toBeTruthy();
    expect((screen.getByTestId('constraint-description') as HTMLInputElement).value).toBe('Rebar not delivered');
    expect(h.command).toHaveBeenCalledWith('raiseLookAheadConstraint', expect.objectContaining({ body: { kind: 'DESIGN', description: 'Rebar not delivered' } }));
  });

  it('says the members could not be loaded and still allows a constraint without an owner', async () => {
    const h = harness(answer, () => ({ operation_id: 'o', status: 'OPEN', resource_version: 1, resource_id: 'k9' }));
    withMembers(h, problem(500, 'INTERNAL'));
    mountAt(h);
    fireEvent.click(await screen.findByTestId('raise-1'));
    expect(await screen.findByTestId('members-error')).toBeTruthy();
    type('constraint-description', 'Rebar not delivered');
    fireEvent.submit(screen.getByTestId('constraint-form'));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
  });
});
