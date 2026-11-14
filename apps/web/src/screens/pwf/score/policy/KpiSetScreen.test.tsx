import { DEFAULT_KPI_SET_PARAMS } from '@machvon/kernel/src/workflow-kpi.ts';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeViolations, seriousViolations } from '../../../../test/axe';
import { mountAs } from '../../templates/test/mount';
import { ALL_PERMISSIONS, refusal, routeOf, serve, text } from '../../test/fixtures';
import type { Answer } from '../../test/fixtures';
import { catalogue, effective, kpiOperations, uuid } from '../test/fixtures';
import KpiSetScreen from './KpiSetScreen';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const route = routeOf('PWF-09');
const TYPE = 'WORKFLOW_KPI_SET';

interface Setup {
  path?: string;
  permissions?: readonly string[];
  mode?: 'FULL' | 'READ_ONLY';
  effective?: Answer;
  catalogue?: Answer;
  operations?: Answer;
  commands?: Record<string, Answer>;
}

const open = (setup: Setup = {}) => {
  const h = serve(
    {
      getEffectiveGovernanceRule: setup.effective ?? effective(TYPE, 'DEFAULT_PROJECT_WORKFLOW', DEFAULT_KPI_SET_PARAMS as Record<string, unknown>),
      getGovernanceRuleCatalog: setup.catalogue ?? catalogue(),
      getKpiOperations: setup.operations ?? kpiOperations(),
      listGovernanceRuleVersions: { items: [] },
    },
    { createGovernanceRuleDraft: { resource_id: uuid(200), status: 'DRAFT', resource_version: 1 }, ...setup.commands },
  );
  mountAs(<KpiSetScreen route={route} />, h, { permissions: setup.permissions ?? ALL_PERMISSIONS, ...(setup.mode === undefined ? {} : { mode: setup.mode }), path: setup.path ?? '/pwf/pwf-09' });
  return h;
};

const field = (path: string) => screen.getByTestId(`field-${path}`) as HTMLInputElement;
const change = (path: string, value: string) => fireEvent.change(field(path), { target: { value } });
const ready = async () => screen.findByTestId('items');

describe('PWF-09: four short pages instead of one long one', () => {
  it('splits the set into tabs (the KPIs, the scales, what each applies to, the versions), keeps the tab in the address, and shows one part of a KPI a tab', async () => {
    open();
    await ready();
    expect(screen.getAllByRole('tab').map((tab) => tab.getAttribute('data-testid'))).toEqual(['catalog', 'scale', 'applies', 'versions'].map((id) => `kpiset-tab-${id}`));
    expect(screen.getByTestId('kpiset-tab-catalog').getAttribute('aria-selected')).toBe('true');
    // Each field lives in one tab only: the weight with the KPI, the scale in its tab, the conditions in theirs.
    expect(screen.getByTestId('kpiset-panel-catalog').contains(field('items[0].weight'))).toBe(true);
    expect(screen.getByTestId('kpiset-panel-scale').contains(screen.getByTestId('scale-0'))).toBe(true);
    expect(screen.getByTestId('kpiset-panel-applies').contains(field('items[0].phases'))).toBe(true);
    expect(screen.getByTestId('kpiset-panel-applies').contains(field('template_code'))).toBe(true);
    expect(screen.getByTestId('kpiset-panel-scale').hasAttribute('hidden')).toBe(true);
    fireEvent.click(screen.getByTestId('kpiset-tab-scale'));
    expect(screen.getByTestId('kpiset-panel-scale').hasAttribute('hidden')).toBe(false);
    expect(screen.getByTestId('kpiset-panel-catalog').hasAttribute('hidden')).toBe(true);
    cleanup();
    open({ path: '/pwf/pwf-09?view=versions' });
    await ready();
    expect(screen.getByTestId('kpiset-tab-versions').getAttribute('aria-selected')).toBe('true');
  });

  it('finds a KPI by its name or its code in every tab and always says how many of how many are shown', async () => {
    open();
    await ready();
    const total = screen.getByTestId('items').querySelectorAll('[data-item]').length;
    expect(total).toBeGreaterThan(1);
    expect(screen.getByTestId('kpi-find-count').textContent).toBe(text('fix10.kpiset.find.count', { shown: total, total }));
    fireEvent.change(screen.getByTestId('kpi-find'), { target: { value: 'return_count' } });
    expect(screen.getByTestId('items').querySelectorAll('[data-item]')).toHaveLength(1);
    expect(screen.getByTestId('items-scale').querySelectorAll('[data-item-part]')).toHaveLength(1);
    expect(screen.getByTestId('kpi-find-count').textContent).toBe(text('fix10.kpiset.find.count', { shown: 1, total }));
    fireEvent.change(screen.getByTestId('kpi-find'), { target: { value: '' } });
    expect(screen.getByTestId('items').querySelectorAll('[data-item]')).toHaveLength(total);
  });

  it('counts on its tab a problem that is in a tab not shown, so nothing wrong is out of sight', async () => {
    open();
    await ready();
    change('items[0].scale.worst', 'abc');
    expect(screen.getByTestId('kpiset-tab-scale').textContent).toContain('1');
    expect(screen.getByTestId('kpiset-tab-catalog').textContent).toBe(text('fix10.kpiset.tab.catalog'));
  });
});

describe('PWF-09: reading the set', () => {
  it('opens the default set: six KPIs with their operation, weight, scale and the RAG line, and says it is a default', async () => {
    open();
    const items = await ready();
    expect(within(items).getAllByRole('listitem', { name: '' }).length).toBeGreaterThan(0);
    expect(field('items[0].kpi_code').value).toBe('PWF_TASK_DEVIATION_DAYS');
    expect((screen.getByTestId('field-items[0].operation') as HTMLSelectElement).value).toBe('DAYS_DEVIATION');
    expect(field('items[0].weight').value).toBe('40');
    expect(field('items[0].scale.worst').value).toBe('10');
    expect(field('items[0].scale.best').value).toBe('0');
    expect(field('items[0].rag_code').value).toBe('PWF_SCORE');
    expect(field('template_code').value).toBe('PUBLIC_INVESTMENT');
    expect(screen.getByTestId('item-count').textContent).toBe(text('pwfs.kpiset.items.count', { count: 6, max: 20 }));
    expect(screen.getByTestId('base-note').textContent).toBe(text('pwfs.kpiset.base.default'));
    expect(screen.getAllByText(text('pwf.common.unverified.label')).length).toBeGreaterThan(0);
  });

  it('shows the unit and the direction of the operation from the catalogue, and only the parameters it takes', async () => {
    open();
    await ready();
    expect(screen.getByTestId('operation-facts-0').textContent).toBe(text('pwfs.kpiset.item.facts.text', { unit: text('pwfs.valueUnit.days.word'), direction: text('pwfs.direction.lower.word') }));
    expect(screen.getByTestId('field-items[0].unit')).toBeTruthy();
    expect(screen.queryByTestId('field-items[0].grace')).toBeNull();
    expect(screen.getByTestId('field-items[1].grace')).toBeTruthy();
    expect(screen.queryByTestId('field-items[1].unit')).toBeNull();
  });

  it('draws the conversion curve of each scale with the same points in words', async () => {
    open({ path: '/pwf/pwf-09?view=scale' });
    await ready();
    const curve = screen.getByTestId('scale-0').querySelector('[data-testid="curve"]') as HTMLElement;
    expect(curve.querySelector('svg')?.getAttribute('role')).toBe('img');
    expect(within(curve).getAllByRole('listitem').length).toBeGreaterThanOrEqual(5);
    expect(within(curve).getByText(text('pwfs.kpiset.curve.point.text', { value: -2, score: 100 }))).toBeTruthy();
  });

  it('starts from blank when nothing governs the code, and is denied without the right to read', async () => {
    open({ effective: refusal('GOVERNANCE_RULE_NOT_FOUND', 404) });
    await ready();
    expect(screen.getByTestId('base-note').textContent).toBe(text('pwfs.kpiset.base.blank'));
    expect(field('items[0].kpi_code').value).toBe('');
    cleanup();
    const h = open({ permissions: [] });
    expect(screen.getByText(text('states.denied.title'))).toBeTruthy();
    expect(h.read).not.toHaveBeenCalled();
  });

  it('shows the set but changes nothing when the session is read-only or the person cannot write rules', async () => {
    open({ mode: 'READ_ONLY' });
    await ready();
    expect(screen.getByTestId('read-only')).toBeTruthy();
    expect(field('items[0].weight').disabled).toBe(true);
    expect(screen.queryByTestId('save')).toBeNull();
    cleanup();
    open({ permissions: ['pwf.read', 'adm.governance.read'] });
    await ready();
    expect(screen.getByTestId('read-only')).toBeTruthy();
  });
});

describe('PWF-09: editing', () => {
  it('moves the curve when a scale changes, and shows a stepped scale as steps', async () => {
    open();
    await ready();
    change('items[0].scale.worst', '20');
    const curve = screen.getByTestId('scale-0').querySelector('[data-testid="curve"]') as HTMLElement;
    expect(within(curve).getByText(text('pwfs.kpiset.curve.point.text', { value: -4, score: 100 }))).toBeTruthy();
    fireEvent.change(screen.getByTestId('field-items[0].scale.kind'), { target: { value: 'STEPPED' } });
    expect(screen.getByTestId('steps-0')).toBeTruthy();
    expect(screen.getByTestId('curve-blocked')).toBeTruthy();
    change('items[0].scale.steps[0].bound', '0');
    change('items[0].scale.steps[0].score', '100');
    expect(screen.queryByTestId('curve-blocked')).toBeNull();
  });

  it('says a bound out of order, a weight out of range and a code that is not in the register, next to each field', async () => {
    open();
    await ready();
    fireEvent.change(screen.getByTestId('field-items[2].scale.mode'), { target: { value: 'AT_MOST' } });
    change('items[2].scale.steps[1].bound', '-1');
    expect(screen.getByTestId('error-items[2].scale.steps[1].bound').textContent).toContain(text('pwfs.rule.problem.order.error'));
    change('items[0].weight', '101');
    expect(screen.getByTestId('error-items[0].weight').textContent).toContain(text('pwfs.rule.problem.range.error', { min: 1, max: 100 }));
    change('items[0].kpi_code', 'NOT_IN_THE_REGISTER');
    await waitFor(() => expect(screen.getByTestId('error-items[0].kpi_code').textContent).toContain(text('pwfs.rule.problem.unknownRef.error')));
  });

  it('refuses two items with the same KPI code', async () => {
    open();
    await ready();
    change('items[1].kpi_code', 'PWF_TASK_DEVIATION_DAYS');
    expect(screen.getByTestId('error-items[1].kpi_code').textContent).toContain(text('pwfs.rule.problem.duplicate.error'));
  });

  it('adds and removes an item and a step, and never goes below one item', async () => {
    open({ effective: refusal('GOVERNANCE_RULE_NOT_FOUND', 404) });
    await ready();
    expect(screen.getByRole('button', { name: text('pwfs.kpiset.item.remove.action') }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: text('pwfs.kpiset.item.add.action') }));
    expect(screen.getByTestId('item-count').textContent).toBe(text('pwfs.kpiset.items.count', { count: 2, max: 20 }));
    fireEvent.click(screen.getAllByRole('button', { name: text('pwfs.kpiset.item.remove.action') })[1] as HTMLElement);
    expect(screen.getByTestId('item-count').textContent).toBe(text('pwfs.kpiset.items.count', { count: 1, max: 20 }));
    fireEvent.click(screen.getByTestId('kpiset-tab-scale'));
    fireEvent.change(screen.getByTestId('field-items[0].scale.kind'), { target: { value: 'STEPPED' } });
    fireEvent.click(screen.getByRole('button', { name: text('pwfs.kpiset.scale.addStep.action') }));
    expect(within(screen.getByTestId('steps-0')).getAllByRole('listitem')).toHaveLength(2);
  });

  it('saves a good set as a draft of the rule store, with exactly the params the kernel reads', async () => {
    const h = open();
    await ready();
    change('items[0].weight', '45');
    fireEvent.change(screen.getByTestId('reason'), { target: { value: 'Tăng trọng số độ lệch ngày theo đề nghị của ban chỉ đạo' } });
    fireEvent.click(screen.getByTestId('save'));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    const call = h.command.mock.calls[0] as [string, { body: { rule_type: string; code: string; params: { items: Array<{ weight: number }> } } }];
    expect(call[0]).toBe('createGovernanceRuleDraft');
    expect(call[1].body).toMatchObject({ rule_type: TYPE, code: 'DEFAULT_PROJECT_WORKFLOW' });
    expect(call[1].body.params.items[0]?.weight).toBe(45);
    expect(call[1].body.params.items).toHaveLength(6);
  });

  it('writes nothing while the form has a problem, and shows every problem', async () => {
    const h = open();
    await ready();
    change('items[0].weight', '0');
    fireEvent.change(screen.getByTestId('reason'), { target: { value: 'Tăng trọng số độ lệch ngày theo đề nghị của ban chỉ đạo' } });
    fireEvent.click(screen.getByTestId('save'));
    await waitFor(() => expect(screen.getByTestId('error-items[0].weight')).toBeTruthy());
    expect(h.command).not.toHaveBeenCalled();
  });
});

describe('PWF-09: the states', () => {
  it('shows the error state when the rule cannot be read', async () => {
    open({ effective: refusal('INTERNAL', 500) });
    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  it('works without the register when it cannot be read (nothing is refused for a reference it cannot check)', async () => {
    open({ catalogue: refusal('INTERNAL', 500), operations: refusal('INTERNAL', 500) });
    await ready();
    change('items[0].kpi_code', 'ANYTHING_AT_ALL');
    expect(screen.queryByTestId('error-items[0].kpi_code')).toBeNull();
    expect(screen.getByTestId('field-items[0].unit')).toBeTruthy();
  });

  it('has no serious accessibility violation', async () => {
    open();
    await ready();
    expect(describeViolations(await seriousViolations(document.body))).toEqual([]);
  });
});
