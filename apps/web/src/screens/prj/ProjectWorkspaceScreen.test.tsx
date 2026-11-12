import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import ProjectWorkspaceScreen from './ProjectWorkspaceScreen';
import { AREA_2, MAKER, PROGRAM, READER, SECTOR_2, client, detail, mount, routeOf, world } from './test-support';
import type { World } from './test-support';

const ROUTE = routeOf('PRJ-03', 'FR-PRJ-03');
const problem = (code: string, status = 409, detailText?: string) => new ApiError({ status, code, correlationId: 'c', detail: detailText, extensions: {} });
const OK = { operation_id: 'o', status: 'CONCEPT', resource_version: 2, resource_id: detail(1).id };
const open = (project: Record<string, unknown> = detail(1)) => `/prj/prj-03?id=${project.id as string}`;

afterEach(cleanup);

const profile = () => screen.getByTestId('profile');
const ready = () => screen.findByTestId('profile');
const set = (label: string, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};
const save = (): void => {
  fireEvent.click(screen.getByRole('button', { name: vi_['prj.workspace.edit.submit.action'] }));
};
const withProject = (project: Record<string, unknown>, overrides: Partial<World> = {}) => world({ details: [project], ...overrides });

describe('ProjectWorkspaceScreen (PRJ-03): the workspace of one project', () => {
  it('shows the record of the project, the stage and the national code in the heading, and the group the rules suggest with the badge of its rule (UI-PRJ-03)', async () => {
    mount(<ProjectWorkspaceScreen route={ROUTE} />, client(world()), { permissions: READER, path: open() });
    await ready();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('DA-2026-001 · Dự án số 1');
    const heading = screen.getByRole('heading', { level: 1 }).parentElement as HTMLElement;
    expect(within(heading).getByTestId('stage').textContent).toBe(vi_['prj.stage.concept.label']);
    expect(within(heading).getByTestId('national-code-missing').textContent).toBe(vi_['prj.nationalCode.missing.badge']);
    const facts = Array.from(profile().querySelectorAll('dt')).map((term) => [term.textContent, term.nextElementSibling?.textContent]);
    expect(facts).toEqual([
      [vi_['prj.workspace.field.code'], 'DA-2026-001'],
      [vi_['prj.workspace.field.name'], 'Dự án số 1'],
      [vi_['prj.workspace.field.owner'], 'Sở Giao thông'],
      [vi_['prj.workspace.field.investor'], 'Ban QLDA tỉnh'],
      [vi_['prj.workspace.field.authority'], 'UBND tỉnh'],
      [vi_['prj.workspace.field.area'], 'Tỉnh P'],
      [vi_['prj.workspace.field.sector'], 'Giao thông'],
      [vi_['prj.workspace.field.projectType'], vi_['prj.workspace.value.none']],
      [vi_['prj.workspace.field.program'], vi_['prj.workspace.value.none']],
      [vi_['prj.workspace.field.total'], vi_['prj.workspace.value.amount'].replace('{amount}', new Intl.NumberFormat('vi').format(500000000000n))],
      [vi_['prj.workspace.field.years'], '2026 – 2028'],
      [vi_['prj.workspace.field.classification'], vi_['prj.classification.internal.label']],
      [vi_['prj.workspace.field.stage'], `${vi_['prj.stage.concept.label']} · ${vi_['prj.life.open.label']}`],
      [vi_['prj.workspace.field.group'], vi_['prj.workspace.value.none']],
      [vi_['prj.workspace.field.score'], vi_['prj.workspace.value.none']],
      [vi_['prj.workspace.field.leader'], vi_['prj.workspace.value.none']],
    ]);
    expect(screen.getByTestId('suggestion').textContent).toContain(vi_['prj.suggestion.group.text'].replace('{group}', 'B').replace('{date}', '2026-10-24'));
    expect(screen.getByTestId('suggestion-awaiting').textContent).toBe(vi_['prj.suggestion.awaitingCxn.badge'].replace('{cxn}', 'CXN-32'));
    expect(screen.getByTestId('suggestion').textContent).toContain(vi_['prj.suggestion.basis.text'].replace('{basis}', 'Luật 58/2024/QH15').replace('{revision}', '1'));
  });

  it('shows a project with a national code and a leader without the missing-code badge, and a rule that is confirmed without a badge', async () => {
    const project = detail(1, {
      national_project_code: '7654321',
      status: 'IMPLEMENTATION',
      project_group: 'B',
      leader_in_charge: { membership_id: 'm', display_name: 'Nguyễn Văn An' },
      investor_unit_name: null,
      decision_authority_unit_name: null,
      start_year: null,
      end_year: 2030,
      appraisal_score: '73.00',
      group_suggestion: { group_key: 'A', sector_key: 'TRANSPORT', as_of: '2026-10-24', rule_version_id: 'r', rule_revision: 2, legal_basis: 'Nghị quyết', awaiting_confirmation: false, cxn: null },
    });
    mount(<ProjectWorkspaceScreen route={ROUTE} />, client(withProject(project)), { permissions: READER, path: open(project) });
    await ready();
    expect(screen.queryByTestId('national-code-missing')).toBeNull();
    expect(screen.getByTestId('national-code').textContent).toBe('7654321');
    expect(screen.queryByTestId('suggestion-awaiting')).toBeNull();
    expect(profile().textContent).toContain('Nguyễn Văn An');
    expect(profile().textContent).toContain('73.00');
    expect(profile().textContent).toContain(' – 2030');
  });

  it('says so when the rule data has no threshold table in force for the proposal date', async () => {
    const project = detail(1, { group_suggestion: null });
    mount(<ProjectWorkspaceScreen route={ROUTE} />, client(withProject(project)), { permissions: READER, path: open(project) });
    await ready();
    expect(screen.getByTestId('suggestion-none').textContent).toBe(vi_['prj.suggestion.none.text']);
  });

  it('fills the other tabs with cards of their own and keeps the tab in the address', async () => {
    mount(<ProjectWorkspaceScreen route={ROUTE} />, client(world()), { permissions: READER, path: open() });
    await ready();
    const tabs = within(screen.getByRole('tablist', { name: vi_['prj.workspace.tabs.title'] })).getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      vi_['prj.workspace.tab.overview'],
      vi_['prj.workspace.tab.objectives'],
      vi_['prj.workspace.tab.plan'],
      vi_['prj.workspace.tab.disbursement'],
      vi_['prj.workspace.tab.issues'],
    ]);
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');
    // Every other tab shows cards of its own (each reads its data on its own; a failed read stays inside its card), never the placeholder notice.
    for (const name of [vi_['prj.workspace.tab.objectives'], vi_['prj.workspace.tab.plan'], vi_['prj.workspace.tab.disbursement'], vi_['prj.workspace.tab.issues']]) {
      fireEvent.click(screen.getByRole('tab', { name }));
      expect(screen.queryByTestId('tab-notice')).toBeNull();
      expect(screen.queryByTestId('tab-failed')).toBeNull();
      expect(within(screen.getByRole('tabpanel')).getAllByRole('region').length).toBeGreaterThan(0);
      expect(screen.getByRole('tab', { name }).getAttribute('aria-selected')).toBe('true');
      expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(screen.getByRole('tab', { name }).id);
    }
    fireEvent.click(screen.getByRole('tab', { name: vi_['prj.workspace.tab.overview'] }));
    expect(screen.getByTestId('profile')).toBeTruthy();
  });

  it('opens on the tab named in the address, so a reload keeps the tab', async () => {
    mount(<ProjectWorkspaceScreen route={ROUTE} />, client(world()), { permissions: READER, path: `${open()}&tab=plan` });
    const tab = await screen.findByRole('tab', { name: vi_['prj.workspace.tab.plan'] });
    await waitFor(() => expect(tab.getAttribute('aria-selected')).toBe('true'));
    expect(screen.queryByTestId('profile')).toBeNull();
  });

  it('says that no project is chosen, and that a project outside the scope or in another tenant is not found (AC-ST-PRJ-001-3)', async () => {
    mount(<ProjectWorkspaceScreen route={ROUTE} />, client(world()), { permissions: READER, path: '/prj/prj-03' });
    expect((await screen.findByTestId('no-project')).textContent).toBe(vi_['prj.workspace.noProject.notice']);
    cleanup();
    const absent = world({ missing: problem('RESOURCE_NOT_FOUND', 404) });
    mount(<ProjectWorkspaceScreen route={ROUTE} />, client(absent), { permissions: READER, path: `/prj/prj-03?id=${detail(9).id}` });
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByTestId('profile')).toBeNull();
  });

  it('says that the project could not be read, with a retry', async () => {
    const state = world({ failing: new Set(['get_resources_project_id']) });
    mount(<ProjectWorkspaceScreen route={ROUTE} />, client(state), { permissions: READER, path: open() });
    expect(await screen.findByRole('alert')).toBeTruthy();
    state.failing = new Set();
    await userEvent.setup().click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
    await ready();
  });
});

describe('ProjectWorkspaceScreen: updating the profile', () => {
  it('sends only what changed, with the version that was read, and shows that it was saved (AC-ST-PRJ-001-2)', async () => {
    const h = client(world(), () => OK);
    mount(<ProjectWorkspaceScreen route={ROUTE} />, h, { permissions: MAKER, path: open() });
    await ready();
    await waitFor(() => expect(within(screen.getByLabelText(vi_['prj.form.sector.label'])).getAllByRole('option').length).toBeGreaterThan(2));
    set(vi_['prj.form.name.label'], '  Tên đã sửa  ');
    set(vi_['prj.form.sector.label'], SECTOR_2);
    set(vi_['prj.form.area.label'], AREA_2);
    set(vi_['prj.form.program.label'], PROGRAM);
    set(vi_['prj.form.endYear.label'], '2029');
    set(vi_['prj.form.classification.label'], 'CONFIDENTIAL');
    save();
    expect((await screen.findByTestId('saved')).textContent).toBe(vi_['prj.workspace.edit.saved.notice']);
    const [operation, input] = h.command.mock.calls[0] as [string, { path: { id: string }; body: Record<string, unknown>; ifMatchVersion: number }];
    expect(operation).toBe('updateProjectProfile');
    expect(input.path.id).toBe(detail(1).id);
    expect(input.ifMatchVersion).toBe(1);
    expect(input.body).toEqual({
      name: 'Tên đã sửa',
      classification: 'CONFIDENTIAL',
      area_master_version_id: AREA_2,
      sector_master_version_id: SECTOR_2,
      program_master_version_id: PROGRAM,
      end_year: 2029,
    });
    // The body never carries the code, the status, the tenant or the money (AC-ST-PRJ-001-4).
    for (const forbidden of ['code', 'status', 'tenant_id', 'total_investment_vnd', 'national_project_code', 'project_group']) expect(Object.keys(input.body)).not.toContain(forbidden);
  });

  it('sends nothing when nothing changed, and nothing when a field is not valid', async () => {
    const h = client(world(), () => OK);
    mount(<ProjectWorkspaceScreen route={ROUTE} />, h, { permissions: MAKER, path: open() });
    await ready();
    save();
    expect(h.command).not.toHaveBeenCalled();
    set(vi_['prj.form.name.label'], 'ab');
    save();
    expect(screen.getByText(vi_['prj.field.tooShort.error'])).toBeTruthy();
    set(vi_['prj.form.name.label'], 'Tên hợp lệ');
    set(vi_['prj.form.startYear.label'], '2031');
    save();
    expect(screen.getByText(vi_['prj.field.order.error'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('tells a stale version from the rest, and reloads the project when asked (AC-ST-PRJ-001-2)', async () => {
    const state = world();
    const h = client(state, () => problem('VERSION_CONFLICT'));
    mount(<ProjectWorkspaceScreen route={ROUTE} />, h, { permissions: MAKER, path: open() });
    await ready();
    set(vi_['prj.form.name.label'], 'Tên từ bản cũ');
    save();
    expect((await screen.findByTestId('problem')).textContent).toBe(vi_['prj.problem.versionConflict.error']);
    state.details = [detail(1, { name: 'Tên do người khác sửa', version: 5 })];
    await userEvent.setup().click(screen.getByRole('button', { name: vi_['prj.workspace.edit.reload.action'] }));
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('DA-2026-001 · Tên do người khác sửa'));
    expect(screen.queryByTestId('problem')).toBeNull();
    expect((screen.getByLabelText(vi_['prj.form.name.label']) as HTMLInputElement).value).toBe('Tên do người khác sửa');
  });

  it.each([
    [problem('STAGE_LOCKED_FIELD', 422, 'start_year'), vi_['prj.problem.stageLockedField.error'].replace('{field}', 'start_year')],
    [problem('MASTER_NOT_EFFECTIVE', 422), vi_['prj.problem.masterNotEffective.error']],
    [problem('FIELD_NOT_ALLOWED', 400), vi_['prj.problem.notAllowed.error']],
    [problem('VALIDATION_FAILED', 422), vi_['prj.problem.validation.error']],
    [problem('RESOURCE_NOT_FOUND', 404), vi_['prj.problem.notFound.error']],
    [problem('SCOPE_DENIED', 403), vi_['prj.problem.denied.error']],
    [problem('STAGE_LOCKED_FIELD', 422), vi_['prj.problem.stageLocked.error']],
    [problem('PROJECT_CODE_DUPLICATE', 409), vi_['prj.problem.duplicateCode.error']],
    [new Error('boom'), vi_['prj.problem.general.error']],
  ])('tells the person why a change was refused (%#)', async (failure, message) => {
    mount(<ProjectWorkspaceScreen route={ROUTE} />, client(world(), () => failure), { permissions: MAKER, path: open() });
    await ready();
    set(vi_['prj.form.name.label'], 'Tên khác');
    save();
    expect((await screen.findByTestId('problem')).textContent).toBe(message);
  });

  it('keeps the entry a project holds in the choices even when it is no longer in force', async () => {
    const project = detail(1, { sector: { version_id: '00000000-0000-4000-8000-00000000dead', business_key: 'OLD-SECTOR', label: 'Lĩnh vực đã hết hiệu lực' } });
    mount(<ProjectWorkspaceScreen route={ROUTE} />, client(withProject(project)), { permissions: MAKER, path: open(project) });
    await ready();
    await waitFor(() => expect(within(screen.getByLabelText(vi_['prj.form.sector.label'])).getAllByRole('option').map((option) => option.textContent)).toContain('OLD-SECTOR · Lĩnh vực đã hết hiệu lực'));
    expect((screen.getByLabelText(vi_['prj.form.sector.label']) as HTMLSelectElement).value).toBe('00000000-0000-4000-8000-00000000dead');
  });

  it('locks the fields of the dossier once the project has left the concept stage, and leaves the name and the classification open', async () => {
    const project = detail(1, { status: 'PIPELINE', project_group: 'B' });
    const h = client(withProject(project), () => OK);
    mount(<ProjectWorkspaceScreen route={ROUTE} />, h, { permissions: MAKER, path: open(project) });
    await ready();
    expect(screen.getByTestId('dossier-locked').textContent).toBe(vi_['prj.form.dossierLocked.notice']);
    for (const label of ['prj.form.investor.label', 'prj.form.area.label', 'prj.form.sector.label', 'prj.form.projectType.label', 'prj.form.program.label', 'prj.form.startYear.label', 'prj.form.endYear.label'] as const) {
      expect(screen.getByLabelText(vi_[label]).matches(':disabled')).toBe(true);
    }
    set(vi_['prj.form.name.label'], 'Tên mới ở ngân hàng dự án');
    save();
    await screen.findByTestId('saved');
    expect((h.command.mock.calls[0] as [string, { body: Record<string, unknown> }])[1].body).toEqual({ name: 'Tên mới ở ngân hàng dự án' });
  });

  it('is read only for a project that has ended, for a reader and for a tenant that is read only', async () => {
    const ended = detail(1, { status: 'CLOSED', project_group: 'B' });
    mount(<ProjectWorkspaceScreen route={ROUTE} />, client(withProject(ended)), { permissions: MAKER, path: open(ended) });
    await ready();
    expect(screen.getByTestId('read-only').textContent).toBe(vi_['prj.workspace.edit.frozen.notice']);
    expect((screen.getByRole('button', { name: vi_['prj.workspace.edit.submit.action'] }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    mount(<ProjectWorkspaceScreen route={ROUTE} />, client(world()), { permissions: READER, path: open() });
    await ready();
    expect(screen.getByTestId('read-only').textContent).toBe(vi_['prj.workspace.edit.denied.notice']);
    cleanup();
    const h = client(world(), () => OK);
    mount(<ProjectWorkspaceScreen route={ROUTE} />, h, { permissions: MAKER, mode: 'READ_ONLY', path: open() });
    await ready();
    expect(screen.getByTestId('read-only')).toBeTruthy();
    fireEvent.submit(screen.getByRole('form', { name: vi_['prj.workspace.edit.title'] }));
    expect(h.command).not.toHaveBeenCalled();
  });

  it('AC-ST-PRJ-003-2: leads a concept to the proposal and a project in appraisal to the scoring and the decision, and no other stage anywhere', async () => {
    mount(<ProjectWorkspaceScreen route={ROUTE} />, client(world()), { permissions: READER, path: open() });
    await ready();
    expect(within(screen.getByTestId('appraisal-links')).getByRole('link', { name: vi_['prj.workspace.appraisal.propose.link'] }).getAttribute('href')).toBe(`/prj/prj-09?id=${detail(1).id as string}`);
    cleanup();
    const appraisal = detail(1, { status: 'APPRAISAL' });
    mount(<ProjectWorkspaceScreen route={ROUTE} />, client(withProject(appraisal)), { permissions: READER, path: open(appraisal) });
    await ready();
    const links = within(screen.getByTestId('appraisal-links'));
    expect(links.getByRole('link', { name: vi_['prj.workspace.appraisal.score.link'] }).getAttribute('href')).toBe(`/prj/prj-15?id=${detail(1).id as string}`);
    expect(links.getByRole('link', { name: vi_['prj.workspace.appraisal.decide.link'] }).getAttribute('href')).toBe(`/prj/prj-10?id=${detail(1).id as string}`);
    cleanup();
    const bank = detail(1, { status: 'PIPELINE', project_group: 'B' });
    mount(<ProjectWorkspaceScreen route={ROUTE} />, client(withProject(bank)), { permissions: READER, path: open(bank) });
    await ready();
    expect(screen.queryByTestId('appraisal-links')).toBeNull();
  });
});
