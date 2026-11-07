import { cleanup, configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t as tr } from '../../i18n';
import { harness, mount, routeOf } from '../mne/test-support';
import type { Harness } from '../mne/test-support';
import DrillScreen from './DrillScreen';
import { toDrill } from './drill-model';

const ROUTE = routeOf('HOME-10', 'FR-HOME-10');
const READER = ['home.read'];
const S40 = '00000000-0000-4000-8000-0000000000f2';
const NORTH = '00000000-0000-4000-8000-000000000012';
const SOUTH = '00000000-0000-4000-8000-000000000013';
const PROJECT = '00000000-0000-4000-8000-000000000555';
const WARNING = '00000000-0000-4000-8000-000000000aaa';
const EXPLANATION = '00000000-0000-4000-8000-000000000bbb';

const fill = (text: string, values: Record<string, string | number>): string => Object.entries(values).reduce((out, [key, value]) => out.replace(`{${key}}`, String(value)), text);
const dong = (billions: number): string => String(billions * 1_000_000_000);

const child = (dimension: string, id: string, code: string, name: string, overrides: Record<string, unknown> = {}) => ({ dimension, id, code, name, value: '60.0000', numerator: dong(600), denominator: dong(1000), null_reason: null, drag_points: null, context_token: `token-${id}`, ...overrides });
const ratio = (overrides: Record<string, unknown> = {}) => ({
  context_token: 'token-self',
  metric_code: 'DISBURSEMENT_RATE_PM',
  level: 'SCOPE',
  step: 1,
  steps_total: 3,
  order: 'code',
  snapshot_id: S40,
  as_of_date: '2027-10-12',
  treasury_cutoff_date: '2027-10-12',
  definition_status: 'SIGNED',
  scope_changed: false,
  scope: { unit_id: null, unit_name: null, project_id: null, project_code: null, project_name: null, line_id: null },
  formula: 'a / b * 100',
  unit: 'PERCENT',
  value: '50.0000',
  numerator: dong(700),
  denominator: dong(1400),
  null_reason: null,
  child_dimension: 'unit',
  child_dimensions: ['unit', 'project'],
  exclusions: [],
  children: [child('unit', NORTH, 'BQL-N', 'Ban Bắc', { drag_points: '-10.0000' }), child('unit', SOUTH, 'BQL-S', 'Ban Nam', { drag_points: '4.2500' })],
  reconciles_to_parent: false,
  non_additive_reason: 'RATIO',
  source_records: [],
  alerts: [],
  next_cursor: null,
  ...overrides,
});

type Query = Record<string, string | number>;
function client(answer: (query: Query) => unknown): Harness {
  return harness((operation, input) => (operation === 'explainHomeMetric' ? answer(((input as { query?: Query }).query ?? {}) as Query) : new Error(`unexpected read ${operation}`)));
}
const calls = (h: Harness): Query[] => h.read.mock.calls.filter((call) => call[0] === 'explainHomeMetric').map((call) => (call[1] as { query: Query }).query);

function Where() {
  const location = useLocation();
  return <output data-testid="where">{location.search}</output>;
}
const screenWith = (
  <>
    <DrillScreen route={ROUTE} />
    <Where />
  </>
);
const OPEN = '/?token=token-start';

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 20_000 });
afterEach(cleanup);

describe('HOME-10 the three steps (G3-3)', () => {
  it('says which of "Chỉ tiêu → Đơn vị → Dự án/hồ sơ" the reader is at, by the step the server gave', async () => {
    const answers: Record<string, unknown> = {
      'token-start': ratio(),
      [`token-${NORTH}`]: ratio({ level: 'UNIT', step: 2, scope: { unit_id: NORTH, unit_name: 'Ban Bắc', project_id: null, project_code: null, project_name: null, line_id: null }, child_dimension: 'project', children: [child('project', PROJECT, 'HD-001', 'Cầu Bến Lức')] }),
      [`token-${PROJECT}`]: ratio({ level: 'PROJECT', step: 3, scope: { unit_id: NORTH, unit_name: 'Ban Bắc', project_id: PROJECT, project_code: 'HD-001', project_name: 'Cầu Bến Lức', line_id: null }, child_dimension: 'cell', child_dimensions: ['cell'], children: [] }),
    };
    const user = userEvent.setup();
    mount(screenWith, client((query) => answers[String(query.context_token)]), { permissions: READER }, OPEN);
    const steps = await screen.findByTestId('drill-steps');
    const current = (): string[] => within(screen.getByTestId('drill-steps')).getAllByRole('listitem').filter((item) => item.getAttribute('aria-current') === 'step').map((item) => item.textContent ?? '');
    expect(within(steps).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['1' + tr('govc.home.drill.step.metric'), '2' + tr('govc.home.drill.step.unit'), '3' + tr('govc.home.drill.step.record')]);
    expect(steps.getAttribute('aria-label')).toBe(fill(tr('govc.home.drill.steps.aria'), { step: 1, total: 3 }));
    expect(current()).toEqual(['1' + tr('govc.home.drill.step.metric')]);
    await user.click(screen.getByRole('button', { name: fill(tr('home.drill.open'), { name: 'BQL-N' }) }));
    await waitFor(() => expect(current()).toEqual(['2' + tr('govc.home.drill.step.unit')]));
    await user.click(screen.getByRole('button', { name: fill(tr('home.drill.open'), { name: 'HD-001' }) }));
    await waitFor(() => expect(current()).toEqual(['3' + tr('govc.home.drill.step.record')]));
    expect(screen.getByTestId('drill-steps').getAttribute('aria-label')).toBe(fill(tr('govc.home.drill.steps.aria'), { step: 3, total: 3 }));
  });
});

describe('HOME-10 the order "kéo tụt nhiều nhất trước" (G3-3)', () => {
  it('offers the toggle for a ratio only, and shows what each part pulls the ratio by', async () => {
    mount(screenWith, client(() => ratio()), { permissions: READER }, OPEN);
    const toggle = await screen.findByTestId('drill-order');
    const [byCode, byDrag] = within(toggle).getAllByRole('button');
    expect(byCode?.getAttribute('aria-pressed')).toBe('true');
    expect(byDrag?.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByTestId(`child-drag-${NORTH}`).textContent).toBe(fill(tr('govc.home.drill.drag'), { value: '-10,00' }));
    expect(screen.getByTestId(`child-drag-${SOUTH}`).textContent).toBe(fill(tr('govc.home.drill.drag'), { value: '4,25' }));
    cleanup();
    mount(screenWith, client(() => ratio({ unit: 'VND', metric_code: 'PLAN_TOTAL', value: dong(100), numerator: null, denominator: null, children: [child('unit', NORTH, 'BQL-N', 'Ban Bắc', { value: dong(100) })] })), { permissions: READER }, OPEN);
    await screen.findByTestId('drill-figure');
    expect(screen.queryByTestId('drill-order')).toBeNull();
    expect(screen.queryByTestId(`child-drag-${NORTH}`)).toBeNull();
  });

  it('asks the server for the order, keeps it in the address, and starts the paging again (a cursor belongs to one order)', async () => {
    const user = userEvent.setup();
    const h = client((query) => {
      const dragFirst = query.order === 'drag';
      const rows = dragFirst ? [child('unit', NORTH, 'BQL-N', 'Ban Bắc', { drag_points: '-10.0000' }), child('unit', SOUTH, 'BQL-S', 'Ban Nam', { drag_points: '4.2500' })] : [child('unit', SOUTH, 'BQL-S', 'Ban Nam', { drag_points: '4.2500' }), child('unit', NORTH, 'BQL-N', 'Ban Bắc', { drag_points: '-10.0000' })];
      return ratio({ order: dragFirst ? 'drag' : 'code', children: query.cursor === undefined ? rows.slice(0, 1) : rows.slice(1), next_cursor: query.cursor === undefined ? `cursor-${dragFirst ? 'drag' : 'code'}` : null });
    });
    mount(screenWith, h, { permissions: READER }, OPEN);
    await screen.findByTestId('drill-order');
    expect(screen.getByTestId(`child-drag-${SOUTH}`)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: tr('home.drill.more') }));
    await waitFor(() => expect(screen.getByTestId(`child-drag-${NORTH}`)).toBeTruthy());
    // The second page of the default order carried the cursor of that order.
    expect(calls(h)[1]).toMatchObject({ cursor: 'cursor-code' });
    expect(calls(h)[1]?.order).toBeUndefined();
    await user.click(within(screen.getByTestId('drill-order')).getByRole('button', { name: tr('govc.home.drill.order.drag') }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('?token=token-start&order=drag'));
    await waitFor(() => expect(calls(h).some((query) => query.order === 'drag')).toBe(true));
    const dragCall = calls(h).find((query) => query.order === 'drag');
    // The reading of the new order starts at its first page: no cursor of the other order goes with it.
    expect(dragCall?.cursor).toBeUndefined();
    await waitFor(() => expect(within(screen.getByTestId('drill-order')).getAllByRole('button')[1]?.getAttribute('aria-pressed')).toBe('true'));
    const rows = await screen.findAllByTestId(/^child-drag-/);
    expect(rows[0]?.getAttribute('data-testid')).toBe(`child-drag-${NORTH}`);
    await user.click(screen.getByRole('button', { name: tr('home.drill.more') }));
    await waitFor(() => expect(calls(h).filter((query) => query.order === 'drag' && query.cursor === 'cursor-drag')).toHaveLength(1));
  });

  it('keeps the order when it goes down a step and comes back, and gives back the division the step had', async () => {
    const user = userEvent.setup();
    const h = client((query) => {
      if (query.context_token === 'token-start') return ratio({ order: query.order === 'drag' ? 'drag' : 'code', child_dimension: query.child_dimension ?? 'unit' });
      return ratio({ level: 'UNIT', step: 2, scope: { unit_id: NORTH, unit_name: 'Ban Bắc', project_id: null, project_code: null, project_name: null, line_id: null }, child_dimension: 'project', child_dimensions: ['project'], children: [child('project', PROJECT, 'HD-001', 'Cầu Bến Lức', { drag_points: '-3.0000' })] });
    });
    mount(screenWith, h, { permissions: READER }, OPEN);
    await screen.findByTestId('drill-order');
    await user.click(within(screen.getByTestId('drill-order')).getByRole('button', { name: tr('govc.home.drill.order.drag') }));
    await user.selectOptions(await screen.findByLabelText(new RegExp(tr('home.drill.dimension.label'))), 'project');
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('?token=token-start&order=drag&dim=project'));
    await user.click(await screen.findByRole('button', { name: fill(tr('home.drill.open'), { name: 'BQL-N' }) }));
    await waitFor(() => expect(calls(h).some((query) => query.context_token === `token-${NORTH}`)).toBe(true));
    // Going down keeps the order, and the new step starts with a division of its own.
    expect(calls(h).find((query) => query.context_token === `token-${NORTH}`)).toMatchObject({ order: 'drag' });
    expect(calls(h).find((query) => query.context_token === `token-${NORTH}`)?.child_dimension).toBeUndefined();
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('?token=token-start&order=drag'));
    expect(await screen.findByTestId(`child-drag-${PROJECT}`)).toBeTruthy();
    await user.click(within(screen.getByTestId('drill-breadcrumb')).getAllByRole('button')[0] as HTMLElement);
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('?token=token-start&order=drag&dim=project'));
    const back = calls(h).filter((query) => query.context_token === 'token-start').pop();
    expect(back).toMatchObject({ order: 'drag', child_dimension: 'project' });
    expect(within(screen.getByTestId('drill-order')).getAllByRole('button')[1]?.getAttribute('aria-pressed')).toBe('true');
  });

  it('takes the order from the address, and reads anything else as the default', async () => {
    const h = client(() => ratio({ order: 'drag' }));
    mount(screenWith, h, { permissions: READER }, '/?token=token-start&order=drag');
    await screen.findByTestId('drill-order');
    expect(calls(h)[0]).toMatchObject({ order: 'drag' });
    cleanup();
    const other = client(() => ratio());
    mount(screenWith, other, { permissions: READER }, '/?token=token-start&order=sideways');
    await screen.findByTestId('drill-order');
    expect(calls(other)[0]?.order).toBeUndefined();
  });

  it('leaves the drag of a figure that is not a ratio empty, and reads the step and the alerts of the answer', () => {
    const read = toDrill(ratio({ level: 'PROJECT', step: 3, alerts: [{ kind: 'EARLY_WARNING', id: WARNING, severity: 'CRITICAL', status: 'OPEN', at: '2027-10-10T00:00:00Z' }, { kind: 'ALIEN', id: 'x', severity: null, status: 'OPEN', at: '' }, { kind: 'EXPLANATION', id: '', severity: null, status: 'OPEN', at: '' }], children: [child('cell', 'c1', 'A', 'a', { drag_points: null })] }));
    expect(read).toMatchObject({ step: 3, stepsTotal: 3, order: 'code' });
    expect(read?.alerts).toEqual([{ kind: 'EARLY_WARNING', id: WARNING, severity: 'CRITICAL', status: 'OPEN', at: '2027-10-10T00:00:00Z' }]);
    expect(read?.children[0]?.dragPoints).toBeNull();
    // An answer from before the steps existed still has its step, by its level.
    expect(toDrill({ ...ratio({ level: 'UNIT' }), step: undefined })?.step).toBe(2);
  });
});

describe('HOME-10 the alerts on the records step (G3-3)', () => {
  const project = (alerts: unknown[]) =>
    ratio({ level: 'PROJECT', step: 3, scope: { unit_id: NORTH, unit_name: 'Ban Bắc', project_id: PROJECT, project_code: 'HD-001', project_name: 'Cầu Bến Lức', line_id: null }, child_dimension: 'cell', child_dimensions: ['cell'], children: [], alerts });

  it('lists the warnings and explanations with their kind, severity, status and day, each with its link', async () => {
    mount(
      screenWith,
      client(() =>
        project([
          { kind: 'EARLY_WARNING', id: WARNING, severity: 'CRITICAL', status: 'OPEN', at: '2027-10-10T03:00:00Z' },
          { kind: 'EXPLANATION', id: EXPLANATION, severity: null, status: 'REQUESTED', at: '2027-10-11T03:00:00Z' },
        ]),
      ),
      { permissions: READER },
      OPEN,
    );
    const block = await screen.findByTestId('drill-alerts');
    const items = within(block).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain(tr('govc.home.drill.alerts.warning'));
    expect(items[0]?.textContent).toContain(tr('home.warnings.status.open'));
    expect(items[0]?.textContent).toContain('10/10/2027');
    expect(within(items[0] as HTMLElement).getByRole('link').getAttribute('href')).toBe(`/home/home-06?warning=${WARNING}`);
    expect(items[1]?.textContent).toContain(tr('govc.home.drill.alerts.explanation'));
    expect(items[1]?.textContent).toContain('11/10/2027');
    expect(within(items[1] as HTMLElement).getByRole('link').getAttribute('href')).toBe('/home/home-02');
    // Ids only: nothing but the words of the screen and the day.
    expect(block.textContent).not.toContain(WARNING);
  });

  it('says there is no open alert on a record that has none, and shows no such block above the records step', async () => {
    mount(screenWith, client(() => project([])), { permissions: READER }, OPEN);
    expect((await screen.findByTestId('drill-alerts-none')).textContent).toBe(tr('govc.home.drill.alerts.none'));
    cleanup();
    mount(screenWith, client(() => ratio()), { permissions: READER }, OPEN);
    await screen.findByTestId('drill-figure');
    expect(screen.queryByTestId('drill-alerts')).toBeNull();
  });
});
