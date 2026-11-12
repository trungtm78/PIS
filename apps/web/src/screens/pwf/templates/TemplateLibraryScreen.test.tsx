import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeViolations, seriousViolations } from '../../../test/axe';
import { ALL_PERMISSIONS, READ_ONLY, refusal, routeOf, serve, templateParams, text } from '../test/fixtures';
import { shippedEffective, templateCatalogue, templateEffective, templateVersion, uuid } from './test/fixtures';
import { mountAs } from './test/mount';
import TemplateLibraryScreen from './TemplateLibraryScreen';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const route = routeOf('PWF-01');

interface Setup {
  permissions?: readonly string[];
  mode?: 'FULL' | 'READ_ONLY';
  catalogue?: unknown;
  versions?: Record<string, unknown[]>;
  effective?: Record<string, unknown>;
}

const open = (setup: Setup = {}) => {
  const h = serve({
    getGovernanceRuleCatalog: setup.catalogue ?? templateCatalogue(),
    listGovernanceRuleVersions: (input: Record<string, unknown>) => {
      const code = (input.query as { code: string }).code;
      return { items: (setup.versions ?? { PUBLIC_INVESTMENT: [templateVersion(2), templateVersion(1, { status: 'RETIRED', phase: 'ENDED', effective_from: '2026-01-01', params: templateParams({ name: 'Mẫu bản 1', tasks: [] }) })], PUBLIC_REPAIR: [] })[code] ?? [] };
    },
    getEffectiveGovernanceRule: (input: Record<string, unknown>) => {
      const code = (input.query as { code: string }).code;
      return (setup.effective ?? { PUBLIC_INVESTMENT: templateEffective(), PUBLIC_REPAIR: shippedEffective() })[code] ?? refusal('GOVERNANCE_RULE_NOT_FOUND', 404);
    },
  });
  mountAs(<TemplateLibraryScreen route={route} />, h, { permissions: setup.permissions ?? ALL_PERMISSIONS, ...(setup.mode === undefined ? {} : { mode: setup.mode }), path: '/pwf/pwf-01' });
  return h;
};

/** The row of a code once it is read (the code is also an option of the comparison). */
const rowFor = async (code: string): Promise<HTMLElement> => {
  const cell = await waitFor(() => within(screen.getByRole('table')).getByText(code));
  return cell.closest('tr') as HTMLElement;
};

describe('PWF-01: the library of workflow templates', () => {
  it('lists each code with its name, project type, versions, what is in force, the day it begins and its size', async () => {
    open();
    expect(await screen.findByText('Mẫu bản 2')).toBeTruthy();
    const table = screen.getByRole('table');
    const investment = within(table).getByText('PUBLIC_INVESTMENT').closest('tr') as HTMLElement;
    expect(within(investment).getByText('CONSTRUCTION')).toBeTruthy();
    expect(within(investment).getByText(text('pwf.templates.lib.force.rule', { version: 2 }))).toBeTruthy();
    expect(within(investment).getByText('01/12/2026')).toBeTruthy();
    expect(within(investment).getByText(text('pwf.templates.lib.size.text', { phases: 1, tasks: 2 }))).toBeTruthy();
    expect(within(investment).getByText(text('pwf.templates.lib.count.text', { status: text('gova1.status.approved'), count: 1 }))).toBeTruthy();
    expect(within(investment).getByText(text('pwf.templates.lib.count.text', { status: text('gova1.status.retired'), count: 1 }))).toBeTruthy();
    expect(within(investment).queryByText(text('pwf.common.unverified.label'))).toBeNull();
  });

  it('shows the shipped template as "default, not yet confirmed", with no day and no version of the tenant', async () => {
    open();
    const repair = await rowFor('PUBLIC_REPAIR');
    expect(within(repair).getByText(text('pwf.common.unverified.label'))).toBeTruthy();
    expect(within(repair).getByText(text('pwf.templates.lib.force.default'))).toBeTruthy();
    expect(within(repair).getByText(text('pwf.templates.lib.noVersions.text'))).toBeTruthy();
    expect(within(repair).getByText('REPAIR')).toBeTruthy();
  });

  it('counts the templates, those a rule of the tenant governs and those not yet confirmed, each with its "i"', async () => {
    open();
    await screen.findByText('Mẫu bản 2');
    const strip = screen.getByRole('group', { name: text('pwf.templates.lib.totals.label') });
    await waitFor(() => expect(within(strip).getAllByRole('button', { name: /.+/ }).length).toBe(3));
    expect(strip.textContent).toContain(text('pwf.templates.lib.totals.templates'));
    expect([...strip.querySelectorAll('.ui-kpi__value')].map((node) => node.textContent)).toEqual(['2', '1', '1']);
    fireEvent.click(within(strip).getAllByRole('button')[2] as HTMLElement);
    expect(screen.getByRole('dialog').textContent).toContain(text('pwf.templates.lib.formula.unverified'));
  });

  it('links to the editor for each code and for a new template, and to the versions of the rule store', async () => {
    open();
    await screen.findByText('Mẫu bản 2');
    expect(screen.getByTestId('new-template').getAttribute('href')).toBe('/pwf/pwf-02');
    expect(screen.getByTestId('edit-PUBLIC_INVESTMENT').getAttribute('href')).toBe('/pwf/pwf-02?code=PUBLIC_INVESTMENT');
    expect(screen.getByTestId('versions-PUBLIC_REPAIR').getAttribute('href')).toBe('/adm/adm-20?type=PROJECT_WORKFLOW_TEMPLATE&code=PUBLIC_REPAIR');
  });

  it('hides the edit links from a person who may only read, and when the session is read-only', async () => {
    open({ permissions: READ_ONLY });
    await screen.findByText('Mẫu bản 2');
    expect(screen.queryByTestId('new-template')).toBeNull();
    expect(screen.queryByTestId('edit-PUBLIC_INVESTMENT')).toBeNull();
    cleanup();
    open({ mode: 'READ_ONLY' });
    await screen.findByText('Mẫu bản 2');
    expect(screen.queryByTestId('new-template')).toBeNull();
  });

  it('is denied without the permission to read, and reads nothing', () => {
    const h = open({ permissions: [] });
    expect(screen.getByText(text('states.denied.title'))).toBeTruthy();
    expect(h.read).not.toHaveBeenCalled();
  });

  it('says so when the rule type has no code yet, and when the catalogue cannot be read', async () => {
    open({ catalogue: templateCatalogue({ codes: [] }) });
    expect(await screen.findByText(text('states.empty.title'))).toBeTruthy();
    cleanup();
    const h = serve({ getGovernanceRuleCatalog: refusal('INTERNAL_ERROR', 500) });
    mountAs(<TemplateLibraryScreen route={route} />, h, { permissions: ALL_PERMISSIONS });
    expect(await screen.findByText(text('states.error.title'))).toBeTruthy();
  });

  it('says that a template could not be read without hiding the others', async () => {
    const h = serve({
      getGovernanceRuleCatalog: templateCatalogue(),
      listGovernanceRuleVersions: (input: Record<string, unknown>) => ((input.query as { code: string }).code === 'PUBLIC_REPAIR' ? refusal('INTERNAL_ERROR', 500) : { items: [templateVersion(2)] }),
      getEffectiveGovernanceRule: templateEffective(),
    });
    mountAs(<TemplateLibraryScreen route={route} />, h, { permissions: ALL_PERMISSIONS });
    expect(await screen.findByTestId('rows-failed')).toBeTruthy();
    expect(await screen.findByText('Mẫu bản 2')).toBeTruthy();
  });

  it('refuses a versions answer it cannot use', async () => {
    const h = serve({ getGovernanceRuleCatalog: templateCatalogue(), listGovernanceRuleVersions: { nothing: true }, getEffectiveGovernanceRule: templateEffective() });
    mountAs(<TemplateLibraryScreen route={route} />, h, { permissions: ALL_PERMISSIONS });
    expect(await screen.findByTestId('rows-failed')).toBeTruthy();
  });

  it('compares two versions of a code: what was added, removed and changed, and a link to the diff of the rule store', async () => {
    open();
    await screen.findByText('Mẫu bản 2');
    expect(screen.getByTestId('compare-pick').textContent).toBe(text('pwf.templates.compare.pick.text'));
    fireEvent.change(screen.getByTestId('compare-code'), { target: { value: 'PUBLIC_INVESTMENT' } });
    await waitFor(() => expect((screen.getByTestId('compare-left') as HTMLSelectElement).disabled).toBe(false));
    fireEvent.change(screen.getByTestId('compare-left'), { target: { value: uuid(101) } });
    fireEvent.change(screen.getByTestId('compare-right'), { target: { value: uuid(102) } });
    const list = await screen.findByTestId('compare-changes');
    expect(list.textContent).toContain('T1');
    expect(list.textContent).toContain(text('pwf.templates.change.added.word'));
    expect(list.querySelectorAll('[data-kind="added"]').length).toBe(2);
    expect(list.querySelector('[data-kind="changed"]')?.textContent).toContain(text('pwf.templates.scope.template.word'));
    expect(screen.getByTestId('compare-diff').getAttribute('href')).toBe(`/adm/adm-22?rule=${uuid(102)}&against=${uuid(101)}`);
  });

  it('compares a version with itself and says nothing differs; and compares with the shipped template without a diff link', async () => {
    open();
    await rowFor('PUBLIC_REPAIR');
    fireEvent.change(screen.getByTestId('compare-code'), { target: { value: 'PUBLIC_INVESTMENT' } });
    await waitFor(() => expect((screen.getByTestId('compare-left') as HTMLSelectElement).disabled).toBe(false));
    fireEvent.change(screen.getByTestId('compare-left'), { target: { value: uuid(102) } });
    fireEvent.change(screen.getByTestId('compare-right'), { target: { value: uuid(102) } });
    expect((await screen.findByTestId('compare-same')).textContent).toBe(text('pwf.templates.compare.same.text'));
    fireEvent.change(screen.getByTestId('compare-code'), { target: { value: 'PUBLIC_REPAIR' } });
    await waitFor(() => expect((screen.getByTestId('compare-left') as HTMLSelectElement).disabled).toBe(false));
    expect(screen.getAllByRole('option', { name: text('pwf.templates.compare.default.option') })).toHaveLength(2);
    fireEvent.change(screen.getByTestId('compare-left'), { target: { value: 'default' } });
    fireEvent.change(screen.getByTestId('compare-right'), { target: { value: 'default' } });
    expect(await screen.findByTestId('compare-same')).toBeTruthy();
    expect(screen.queryByTestId('compare-diff')).toBeNull();
  });

  it('has no serious accessibility violation', async () => {
    open();
    await screen.findByText('Mẫu bản 2');
    expect(describeViolations(await seriousViolations(document.body))).toEqual([]);
  });
});

