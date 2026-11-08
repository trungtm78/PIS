import { ApiError } from '@machvon/api-client';
import { cleanup, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t as tr, translator } from '../../i18n';
import { harness, mount, routeOf, TENANT } from '../mne/test-support';
import type { Harness } from '../mne/test-support';
import BottleneckScreen, { amountReason, bucketLabel, causeAction, causeLabel, holderLabel } from './BottleneckScreen';
import HaltedProjectsScreen, { planLabel } from './HaltedProjectsScreen';
import { sourceLink, toAnalysis, toDossier, toHaltedList } from './bottleneck-model';

const READER = ['home.read'];
const ALL = ['home.read', 'home.halt.record', 'home.halt.plan', 'home.halt.approve', 'home.halt.close'];
const ME = TENANT.membershipId;
const OTHER = '00000000-0000-4000-8000-0000000000aa';
const P1 = '00000000-0000-4000-8000-0000000000a1';
const U1 = '00000000-0000-4000-8000-0000000000b1';
const D1 = '00000000-0000-4000-8000-0000000000d1';
const S1 = '00000000-0000-4000-8000-0000000000e1';
const fill = (text: string, values: Record<string, string | number>): string => Object.entries(values).reduce((out, [key, value]) => out.replace(`{${key}}`, String(value)), text);

const item = (key: string, over: Record<string, unknown> = {}) => ({
  key,
  source: key.split(':')[0],
  source_id: key.split(':')[1],
  project: { id: P1, code: 'P-1' },
  unit_id: U1,
  cause_code: 'PAYMENT_PENDING_TREASURY',
  cause_known: true,
  owner_module: 'PAY',
  amount_vnd: '500000000',
  amount_null_reason: null,
  since: '2027-10-10',
  age_days: 10,
  bucket: 'LE_30',
  holder: { kind: 'EXTERNAL', id: null, name: null, code: 'TREASURY' },
  merged_keys: [],
  ...over,
});
const analysis = (over: Record<string, unknown> = {}) => ({
  as_of: '2027-10-20',
  model: { rule_version: 'builtin', unverified: true, causes: [{ code: 'PAYMENT_PENDING_TREASURY', owner_module: 'PAY' }, { code: 'ISSUE_UNRESOLVED', owner_module: 'ISS' }], buckets: ['LE_7', 'LE_30', 'LE_90', 'GT_90'], issue_min_severity: 'HIGH' },
  info: { formula: 'Held amount', source: 'Sources', as_of: '2026-11-08', rule_version: 'builtin', unverified: true },
  held_vnd: '800000000',
  no_amount: 1,
  merged: 1,
  sources: [{ source: 'PAYMENT', items: 2, skipped: 0, cut: false }, { source: 'ISSUE', items: 1, skipped: 2, cut: true }],
  by_cause: [{ key: 'PAYMENT_PENDING_TREASURY', count: 2, amount_vnd: '800000000', no_amount: 0 }, { key: 'ISSUE_UNRESOLVED', count: 1, amount_vnd: '0', no_amount: 1 }],
  by_bucket: [{ key: 'LE_7', count: 0, amount_vnd: '0', no_amount: 0 }, { key: 'LE_30', count: 2, amount_vnd: '800000000', no_amount: 0 }, { key: 'LE_90', count: 1, amount_vnd: '0', no_amount: 1 }, { key: 'GT_90', count: 0, amount_vnd: '0', no_amount: 0 }],
  by_holder: [{ key: 'EXTERNAL:TREASURY', holder: { kind: 'EXTERNAL', id: null, name: null, code: 'TREASURY' }, count: 2, amount_vnd: '800000000', no_amount: 0 }],
  items_total: 3,
  items: [item('PAYMENT:p1', { merged_keys: ['ISSUE:i1'] }), item('PAYMENT:p2', { amount_vnd: '300000000' }), item('ISSUE:i2', { source: 'ISSUE', cause_code: 'ISSUE_UNRESOLVED', amount_vnd: null, amount_null_reason: 'NO_AMOUNT', holder: { kind: 'PERSON', id: 'x', name: 'Clerk', code: null }, bucket: 'LE_90', age_days: 80 })],
  ...over,
});
const stepRow = (id: string, status: string, note: string | null = null) => ({ id, plan_version: 1, ordinal: 1, title: 'Pay the twelve households', owner: null, owner_unit: { id: U1, name: 'Unit' }, due_on: '2027-11-15', status, close_note: note });
const dossier = (id: string, status: string, over: Record<string, unknown> = {}, steps: unknown[] = []) => ({
  id,
  project: { id: P1, code: 'P-1', name: 'Bridge', status: 'SUSPENDED' },
  unit: { id: U1, name: 'Unit' },
  reason_code: 'LAND_CLEARANCE',
  reason_text: 'Twelve households have not accepted the compensation.',
  halted_on: '2027-09-01',
  age_days: 49,
  order_ref: 'Decision 15/QD',
  expected_restart_on: '2027-12-01',
  status,
  plan: { version: steps.length === 0 ? 0 : 1, state: steps.length === 0 ? 'NO_PLAN' : status === 'HALTED' ? 'AWAITING_APPROVAL' : 'ON_TRACK', saved_by: steps.length === 0 ? null : { id: OTHER, name: 'Planner' }, decision: null, decided_by: null, decided_at: null, decision_note: null, steps_total: steps.length, steps_open: steps.length, steps_overdue: 0 },
  closed_by: null,
  closed_at: null,
  close_note: null,
  restarted_on: null,
  created_by: { id: ME, name: 'Me' },
  created_at: '2027-09-02T00:00:00.000Z',
  steps,
  ...over,
});
const halted = (items: unknown[], over: Record<string, unknown> = {}) => ({ as_of: '2027-10-20', items, undocumented: [{ project: { id: 'pp', code: 'P-9', name: 'Road' }, unit: { id: U1, name: 'Unit' } }], causes: [{ code: 'LAND_CLEARANCE', owner_module: 'LND' }, { code: 'OTHER', owner_module: 'PRJ' }], plan_min_steps: 1, rule_version: 'builtin', unverified: true, ...over });

interface Answers {
  analysis?: (query: Record<string, unknown>) => unknown;
  list?: () => unknown;
  one?: (id: string) => unknown;
  command?: (operation: string, input: { body?: Record<string, unknown>; path?: Record<string, string> }) => unknown;
}
function client(answers: Answers = {}): Harness {
  return harness(
    (operation, input) => {
      const query = ((input as { query?: Record<string, unknown> }).query ?? {}) as Record<string, unknown>;
      if (operation === 'getBottleneckAnalysis') return (answers.analysis ?? (() => analysis()))(query);
      if (operation === 'listHaltedProjects') return (answers.list ?? (() => halted([dossier(D1, 'HALTED')])))();
      if (operation === 'getHaltedProject') return (answers.one ?? ((id) => dossier(id, 'HALTED')))((input as { path: { id: string } }).path.id);
      return new Error(`unexpected read ${operation}`);
    },
    (operation, input) => (answers.command ?? (() => ({ operation_id: 'op', status: 'OK', resource_version: 1, resource_id: D1 })))(operation, input as never),
  );
}
const commands = (h: Harness, operation: string): Array<{ body?: Record<string, unknown>; path?: Record<string, string> }> => h.command.mock.calls.filter((call) => call[0] === operation).map((call) => call[1] as { body?: Record<string, unknown>; path?: Record<string, string> });

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 20_000 });
afterEach(cleanup);

describe('BI-27 the bottlenecks (G3-9)', () => {
  const ROUTE = routeOf('BI-27', 'FR-BI-27');

  it('shows the amount held with its lower-bound note, the causes with owner and action, the buckets and the holders', async () => {
    mount(<BottleneckScreen route={ROUTE} />, client(), { permissions: READER });
    const tiles = await screen.findByTestId('bn-tiles');
    expect(within(tiles).getByTestId('bn-tile-held').textContent).toContain('800.000.000');
    expect(tiles.textContent).toContain(fill(tr('ana.bn.tile.lowerBound'), { count: 1 }));
    expect(within(tiles).getByTestId('bn-tile-merged').textContent).toBe('1');
    const causes = within(screen.getByTestId('bn-causes')).getAllByTestId('bn-cause');
    expect(causes[0]?.textContent).toContain(tr('ana.bn.cause.PAYMENT_PENDING_TREASURY'));
    expect(causes[0]?.textContent).toContain('PAY');
    expect(causes[0]?.textContent).toContain(tr('ana.bn.action.PAYMENT_PENDING_TREASURY'));
    expect(causes[1]?.textContent).toContain(fill(tr('ana.bn.noAmountOf'), { count: 1 }));
    expect(screen.getByTestId('bn-buckets').textContent).toContain(tr('ana.bn.bucket.gt').replace('{days}', '90'));
    expect(screen.getByTestId('bn-holders').textContent).toContain(tr('ana.bn.holder.treasury'));
    expect(screen.getByTestId('ana-unverified')).toBeTruthy();
  });

  it('lists the items with the amount or N/A and its reason, the age and since, the holder, and a link to the record', async () => {
    mount(<BottleneckScreen route={ROUTE} />, client(), { permissions: READER });
    const rows = within(await screen.findByTestId('bn-items')).getAllByTestId('bn-item');
    expect(rows).toHaveLength(3);
    expect(within(rows[0] as HTMLElement).getByTestId('bn-amount').textContent).toBe('500.000.000');
    expect(rows[0]?.textContent).toContain(fill(tr('ana.bn.merged'), { count: 1 }));
    const noAmount = within(rows[2] as HTMLElement).getByTestId('bn-amount');
    expect(noAmount.textContent).toContain(tr('ana.common.na'));
    expect(noAmount.textContent).toContain(tr('ana.bn.na.noAmount'));
    expect(rows[2]?.textContent).toContain('Clerk');
    expect(within(rows[2] as HTMLElement).getByRole('link').getAttribute('href')).toBe('/iss/iss-03?id=i2');
    expect(within(rows[1] as HTMLElement).getByRole('link').getAttribute('href')).toBe('/pay/pay-03');
  });

  it('says a source was cut and rows were left out for want of a day', async () => {
    mount(<BottleneckScreen route={ROUTE} />, client(), { permissions: READER });
    expect((await screen.findByTestId('bn-cut')).textContent).toContain(tr('ana.bn.source.issue'));
    expect(screen.getByTestId('bn-skipped').textContent).toBe(fill(tr('ana.bn.skipped'), { source: tr('ana.bn.source.issue'), count: 2 }));
  });

  it('asks again by cause and by bucket', async () => {
    const h = client();
    mount(<BottleneckScreen route={ROUTE} />, h, { permissions: READER });
    await screen.findByTestId('bn-items');
    fireEvent.change(screen.getByTestId('bn-filter-cause'), { target: { value: 'ISSUE_UNRESOLVED' } });
    await waitFor(() => expect(h.read.mock.calls.some((call) => (call[1] as { query: Record<string, unknown> }).query.cause === 'ISSUE_UNRESOLVED')).toBe(true));
    fireEvent.change(screen.getByTestId('bn-filter-bucket'), { target: { value: 'GT_90' } });
    await waitFor(() => expect(h.read.mock.calls.some((call) => (call[1] as { query: Record<string, unknown> }).query.bucket === 'GT_90')).toBe(true));
  });

  it('shows the empty, error and denied states and an empty match for a filter', async () => {
    mount(<BottleneckScreen route={ROUTE} />, client({ analysis: () => analysis({ items_total: 0, items: [], held_vnd: '0', no_amount: 0, merged: 0, by_cause: [], by_bucket: [], by_holder: [], sources: [] }) }), { permissions: READER });
    expect(await screen.findByText(tr('states.empty.title'))).toBeTruthy();
    cleanup();
    mount(<BottleneckScreen route={ROUTE} />, client({ analysis: () => new Error('boom') }), { permissions: READER });
    expect(await screen.findByRole('alert')).toBeTruthy();
    cleanup();
    mount(<BottleneckScreen route={ROUTE} />, client({ analysis: () => new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }) }), { permissions: READER });
    expect((await screen.findByRole('alert')).textContent).toContain(tr('states.denied.title'));
  });

  it('turns causes, buckets, holders and reasons into words and reads wrong answers as nothing', () => {
    expect(causeLabel(translator.t, 'LAND_CLEARANCE')).toBe(tr('ana.bn.cause.LAND_CLEARANCE'));
    expect(causeLabel(translator.t, 'TENANT_CAUSE')).toBe('TENANT_CAUSE');
    expect(causeAction(translator.t, 'TENANT_CAUSE')).toBe(tr('ana.bn.action.default'));
    expect(bucketLabel(translator.t, 'LE_30')).toBe(fill(tr('ana.bn.bucket.le'), { days: 30 }));
    expect(bucketLabel(translator.t, 'odd')).toBe('odd');
    expect(holderLabel(translator.t, { kind: 'PERSON', id: 'x', name: null, code: null })).toBe(tr('ana.bn.holder.person'));
    expect(holderLabel(translator.t, { kind: 'EXTERNAL', id: null, name: null, code: 'BANK' })).toBe('BANK');
    expect(amountReason(translator.t, 'WHATEVER')).toBe(tr('ana.bn.na.other'));
    expect(toAnalysis({})).toBeUndefined();
    expect(toHaltedList({})).toBeUndefined();
    expect(toDossier({ id: 'x' })).toBeUndefined();
    expect(sourceLink({ source: 'HALT', sourceId: 'h' })).toBe('/bi/bi-28?id=h');
    expect(sourceLink({ source: 'LAND', sourceId: 'l' })).toBe('/lnd/lnd-07');
  });
});

describe('BI-28 the halted projects (G3-9)', () => {
  const ROUTE = routeOf('BI-28', 'FR-BI-28');

  it('lists the dossiers with the cause, the days halted and the state of the plan, and the suspended project with no dossier', async () => {
    mount(<HaltedProjectsScreen route={ROUTE} />, client(), { permissions: READER });
    const row = await screen.findByTestId('halt-row');
    expect(row.textContent).toContain(tr('ana.bn.cause.LAND_CLEARANCE'));
    expect(row.textContent).toContain(fill(tr('ana.bn.age.days'), { days: 49 }));
    expect(row.textContent).toContain(planLabel(translator.t, 'NO_PLAN'));
    expect(screen.getByTestId('halt-gap').textContent).toContain('P-9');
    expect(screen.queryByTestId('halt-record-pp')).toBeNull();
  });

  it('makes the dossier of a suspended project from the gap list, with cause, day and words', async () => {
    const h = client();
    const user = userEvent.setup();
    mount(<HaltedProjectsScreen route={ROUTE} />, h, { permissions: ALL });
    fireEvent.click(await screen.findByTestId('halt-record-pp'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByTestId('halt-date'), { target: { value: '2027-09-01' } });
    fireEvent.change(within(dialog).getByTestId('halt-order'), { target: { value: 'Decision 15/QD' } });
    await user.type((dialog.querySelector('textarea') as HTMLTextAreaElement), 'Twelve households have not accepted the compensation.');
    await user.click(within(dialog).getByRole('button', { name: tr('ana.halt.dialog.confirm') }));
    await waitFor(() => expect(commands(h, 'recordProjectHalt')).toHaveLength(1));
    expect(commands(h, 'recordProjectHalt')[0]?.body).toEqual({ project_id: 'pp', reason_code: 'LAND_CLEARANCE', reason_text: 'Twelve households have not accepted the compensation.', halted_on: '2027-09-01', order_ref: 'Decision 15/QD' });
    expect((await screen.findByTestId('halt-notice')).textContent).toBe(tr('ana.halt.record.done'));
  });

  it('opens a dossier, shows the reason and the plan, and saves a plan with steps owned by the unit of the project', async () => {
    const h = client();
    mount(<HaltedProjectsScreen route={ROUTE} />, h, { permissions: ALL });
    fireEvent.click(await screen.findByTestId(`halt-open-${D1}`));
    expect((await screen.findByTestId('halt-reason')).textContent).toContain('Twelve households');
    expect(screen.getByTestId('halt-no-plan')).toBeTruthy();
    const save = screen.getByTestId('halt-plan-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('halt-plan-title-0'), { target: { value: 'Pay the twelve households' } });
    fireEvent.change(screen.getByTestId('halt-plan-due-0'), { target: { value: '2027-11-15' } });
    fireEvent.change(screen.getByTestId('halt-plan-expected'), { target: { value: '2027-12-01' } });
    fireEvent.click(screen.getByTestId('halt-plan-add'));
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('halt-plan-title-1'), { target: { value: 'Hand over the site' } });
    fireEvent.change(screen.getByTestId('halt-plan-due-1'), { target: { value: '2027-11-30' } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(commands(h, 'saveRestartPlan')).toHaveLength(1));
    expect(commands(h, 'saveRestartPlan')[0]).toMatchObject({ path: { id: D1 }, body: { steps: [{ title: 'Pay the twelve households', owner_unit_id: U1, due_on: '2027-11-15' }, { title: 'Hand over the site', owner_unit_id: U1, due_on: '2027-11-30' }], expected_restart_on: '2027-12-01' } });
  });

  it('lets somebody other than the author approve or return a plan, and not the author', async () => {
    const waiting = dossier(D1, 'HALTED', {}, [stepRow(S1, 'OPEN')]);
    const h = client({ one: () => waiting });
    const user = userEvent.setup();
    mount(<HaltedProjectsScreen route={ROUTE} />, h, { permissions: ALL });
    fireEvent.click(await screen.findByTestId(`halt-open-${D1}`));
    fireEvent.click(await screen.findByTestId('halt-approve'));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox'), 'The plan is realistic.');
    await user.click(within(dialog).getByRole('button', { name: tr('ana.halt.dialog.confirm') }));
    await waitFor(() => expect(commands(h, 'decideRestartPlan')).toHaveLength(1));
    expect(commands(h, 'decideRestartPlan')[0]).toMatchObject({ path: { id: D1 }, body: { decision: 'APPROVE', note: 'The plan is realistic.' } });
    cleanup();
    mount(<HaltedProjectsScreen route={ROUTE} />, client({ one: () => dossier(D1, 'HALTED', { plan: { ...waiting.plan, saved_by: { id: ME, name: 'Me' } } }, [stepRow(S1, 'OPEN')]) }), { permissions: ALL });
    fireEvent.click(await screen.findByTestId(`halt-open-${D1}`));
    expect((await screen.findByText(tr('ana.halt.plan.maker'))).textContent).toBeTruthy();
    expect(screen.queryByTestId('halt-approve')).toBeNull();
  });

  it('closes the steps with words, and records the restart only when asked, with the day', async () => {
    const planned = dossier(D1, 'RESTART_PLANNED', {}, [stepRow(S1, 'OPEN')]);
    const h = client({ one: () => planned });
    const user = userEvent.setup();
    mount(<HaltedProjectsScreen route={ROUTE} />, h, { permissions: ALL });
    fireEvent.click(await screen.findByTestId(`halt-open-${D1}`));
    fireEvent.click(await screen.findByTestId(`halt-step-done-${S1}`));
    let dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox'), 'All paid on 5 November.');
    await user.click(within(dialog).getByRole('button', { name: tr('ana.halt.dialog.confirm') }));
    await waitFor(() => expect(commands(h, 'closeRestartStep')).toHaveLength(1));
    expect(commands(h, 'closeRestartStep')[0]).toMatchObject({ path: { id: D1, step_id: S1 }, body: { status: 'DONE', note: 'All paid on 5 November.' } });
    fireEvent.click(await screen.findByTestId('halt-restarted'));
    dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByTestId('halt-restarted-on'), { target: { value: '2027-10-18' } });
    await user.type(within(dialog).getByRole('textbox'), 'Work is back on site.');
    await user.click(within(dialog).getByRole('button', { name: tr('ana.halt.dialog.confirm') }));
    await waitFor(() => expect(commands(h, 'closeProjectHalt')).toHaveLength(1));
    expect(commands(h, 'closeProjectHalt')[0]).toMatchObject({ path: { id: D1 }, body: { outcome: 'RESTARTED', note: 'Work is back on site.', restarted_on: '2027-10-18' } });
  });

  it('says why a restart was refused inside the dialog and keeps it open', async () => {
    const h = client({ one: () => dossier(D1, 'RESTART_PLANNED', {}, [stepRow(S1, 'OPEN')]), command: () => new ApiError({ status: 409, code: 'PROJECT_HALT_STEPS_OPEN', correlationId: 'c' }) });
    const user = userEvent.setup();
    mount(<HaltedProjectsScreen route={ROUTE} />, h, { permissions: ALL });
    fireEvent.click(await screen.findByTestId(`halt-open-${D1}`));
    fireEvent.click(await screen.findByTestId('halt-restarted'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByTestId('halt-restarted-on'), { target: { value: '2027-10-18' } });
    await user.type(within(dialog).getByRole('textbox'), 'Work is back on site.');
    await user.click(within(dialog).getByRole('button', { name: tr('ana.halt.dialog.confirm') }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain(tr('ana.halt.problem.stepsOpen'));
  });

  it('shows no action to a reader, shows a closed dossier with its note, and the empty, error and denied states', async () => {
    mount(<HaltedProjectsScreen route={ROUTE} />, client({ one: () => dossier(D1, 'RESTARTED', { restarted_on: '2027-10-18', close_note: 'Work is back on site.', plan: { ...dossier(D1, 'HALTED').plan, state: 'DONE', version: 1 } }, [stepRow(S1, 'DONE', 'Paid.')]) }), { permissions: READER });
    fireEvent.click(await screen.findByTestId(`halt-open-${D1}`));
    expect((await screen.findByTestId('halt-close-note')).textContent).toContain('Work is back on site.');
    expect(screen.queryByTestId('halt-restarted')).toBeNull();
    expect(screen.queryByTestId('halt-plan-form')).toBeNull();
    cleanup();
    mount(<HaltedProjectsScreen route={ROUTE} />, client({ list: () => halted([], { undocumented: [] }) }), { permissions: READER });
    expect(await screen.findByText(tr('states.empty.title'))).toBeTruthy();
    cleanup();
    mount(<HaltedProjectsScreen route={ROUTE} />, client({ list: () => new Error('boom') }), { permissions: READER });
    expect(await screen.findByRole('alert')).toBeTruthy();
    cleanup();
    mount(<HaltedProjectsScreen route={ROUTE} />, client({ list: () => new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }) }), { permissions: READER });
    expect((await screen.findByRole('alert')).textContent).toContain(tr('states.denied.title'));
  });
});
