import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import ProjectCreateScreen from './ProjectCreateScreen';
import { AREA, MAKER, READER, SECTOR, UNIT_DEPARTMENT, UNIT_PROVINCE, client, detail, mount, routeOf, world } from './test-support';
import type { World } from './test-support';

const ROUTE = routeOf('PRJ-02', 'FR-PRJ-02');
const problem = (code: string, status = 409, detailText?: string) => new ApiError({ status, code, correlationId: 'c', detail: detailText, extensions: {} });
const CREATED = detail(7, { code: 'DA-NEW' });

afterEach(cleanup);

const set = (label: string, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};
const ready = () => waitFor(() => expect(within(screen.getByLabelText(vi_['prj.form.owner.label'])).getAllByRole('option').length).toBeGreaterThan(1));
const creating = (overrides: Partial<World> = {}, command: (operation: string, input: unknown) => unknown = () => ({ operation_id: 'o', status: 'CONCEPT', resource_version: 1, resource_id: CREATED.id })) =>
  client(world({ details: [CREATED], ...overrides }), command);

async function fill(): Promise<void> {
  await ready();
  set(vi_['prj.form.code.label'], ' DA-NEW ');
  set(vi_['prj.form.name.label'], ' Cầu mới qua sông ');
  set(vi_['prj.form.owner.label'], UNIT_DEPARTMENT);
  set(vi_['prj.form.area.label'], AREA);
  set(vi_['prj.form.total.label'], '500000000000');
}
const submit = (): void => {
  fireEvent.click(screen.getByRole('button', { name: vi_['prj.create.submit.action'] }));
};

describe('ProjectCreateScreen (PRJ-02): a project is created in the stage CONCEPT', () => {
  it('shows the fields of the screen and the rules that apply, with the units and the entries in force to choose from (UI-PRJ-02)', async () => {
    mount(<ProjectCreateScreen route={ROUTE} />, creating(), { permissions: MAKER });
    await ready();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['prj.create.page.title']);
    const options = (label: string) => within(screen.getByLabelText(label)).getAllByRole('option').map((option) => option.textContent);
    expect(options(vi_['prj.form.owner.label'])).toEqual([vi_['prj.form.choose.option'], 'U1 · Ban QLDA tỉnh', 'U2 · Sở Giao thông']);
    expect(options(vi_['prj.form.area.label'])).toEqual([vi_['prj.form.choose.option'], 'TINH-P · Tỉnh P', 'TINH-Q · Tỉnh Q']);
    // An entry that is retired is not offered.
    await waitFor(() => expect(options(vi_['prj.form.sector.label'])).toEqual([vi_['prj.form.choose.option'], 'TRANSPORT · Giao thông', 'ENERGY · Năng lượng']));
    expect(options(vi_['prj.form.projectType.label']).length).toBe(2);
    expect(options(vi_['prj.form.program.label']).length).toBe(2);
    expect(screen.getByText(vi_['prj.create.group.text'])).toBeTruthy();
    expect(screen.getByText(vi_['prj.create.nationalCode.text'])).toBeTruthy();
    expect(screen.getByText(vi_['prj.create.stage.text'])).toBeTruthy();
    expect((screen.getByLabelText(vi_['prj.form.classification.label']) as HTMLSelectElement).value).toBe('INTERNAL');
  });

  it('names what is missing or wrong and sends nothing', async () => {
    const h = creating();
    mount(<ProjectCreateScreen route={ROUTE} />, h, { permissions: MAKER });
    await ready();
    submit();
    expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toEqual(expect.arrayContaining([vi_['prj.field.required.error']]));
    expect(screen.getByLabelText(vi_['prj.form.code.label']).getAttribute('aria-invalid')).toBe('true');
    set(vi_['prj.form.code.label'], 'X'.repeat(51));
    set(vi_['prj.form.name.label'], 'ab');
    set(vi_['prj.form.owner.label'], UNIT_DEPARTMENT);
    set(vi_['prj.form.area.label'], AREA);
    set(vi_['prj.form.total.label'], '1.5');
    set(vi_['prj.form.startYear.label'], '2030');
    set(vi_['prj.form.endYear.label'], '2026');
    submit();
    const messages = screen.getAllByRole('alert').map((alert) => alert.textContent);
    expect(messages).toEqual(expect.arrayContaining([vi_['prj.field.tooLong.error'], vi_['prj.field.tooShort.error'], vi_['prj.field.invalidAmount.error'], vi_['prj.field.order.error']]));
    set(vi_['prj.form.startYear.label'], '20');
    submit();
    expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toContain(vi_['prj.field.invalidYear.error']);
    expect(h.command).not.toHaveBeenCalled();
  });

  it('creates the project with what was typed, the investor being the owner unit by default, and then shows the suggested group with the badge of its rule (AC-ST-PRJ-001-1)', async () => {
    const h = creating();
    mount(<ProjectCreateScreen route={ROUTE} />, h, { permissions: MAKER });
    await fill();
    set(vi_['prj.form.startYear.label'], '2026');
    set(vi_['prj.form.endYear.label'], '2028');
    set(vi_['prj.form.sector.label'], SECTOR);
    submit();
    const created = await screen.findByTestId('created');
    expect(h.command).toHaveBeenCalledTimes(1);
    const [operation, input] = h.command.mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(operation).toBe('createProject');
    expect(input.body).toEqual({
      code: 'DA-NEW',
      name: 'Cầu mới qua sông',
      owner_unit_id: UNIT_DEPARTMENT,
      investor_unit_id: UNIT_DEPARTMENT,
      area_master_version_id: AREA,
      sector_master_version_id: SECTOR,
      total_investment_vnd: '500000000000',
      classification: 'INTERNAL',
      start_year: 2026,
      end_year: 2028,
    });
    expect(within(created).getByText(vi_['prj.create.done.text'])).toBeTruthy();
    await waitFor(() => expect(within(created).getByTestId('suggestion')).toBeTruthy());
    expect(within(created).getByTestId('suggestion-awaiting').textContent).toBe(vi_['prj.suggestion.awaitingCxn.badge'].replace('{cxn}', 'CXN-32'));
    expect(within(created).getByTestId('suggestion').textContent).toContain(vi_['prj.suggestion.group.text'].replace('{group}', 'B').replace('{date}', '2026-10-24'));
    expect(within(created).getByRole('link', { name: vi_['prj.create.done.open'] }).getAttribute('href')).toBe(`/prj/prj-03?id=${CREATED.id}`);
    // The form is closed once the project exists: a second press creates nothing.
    expect(screen.getByLabelText(vi_['prj.form.code.label']).matches(':disabled')).toBe(true);
    submit();
    expect(h.command).toHaveBeenCalledTimes(1);
  });

  it('keeps an explicit investor and the optional fields that were chosen, and leaves out the ones that were not', async () => {
    const h = creating();
    mount(<ProjectCreateScreen route={ROUTE} />, h, { permissions: MAKER });
    await fill();
    set(vi_['prj.form.investor.label'], UNIT_PROVINCE);
    set(vi_['prj.form.authority.label'], UNIT_PROVINCE);
    set(vi_['prj.form.classification.label'], 'CONFIDENTIAL');
    submit();
    await screen.findByTestId('created');
    const input = (h.command.mock.calls[0] as [string, { body: Record<string, unknown> }])[1];
    expect(input.body).toMatchObject({ investor_unit_id: UNIT_PROVINCE, decision_authority_unit_id: UNIT_PROVINCE, classification: 'CONFIDENTIAL' });
    expect(Object.keys(input.body)).not.toContain('sector_master_version_id');
    expect(Object.keys(input.body)).not.toContain('start_year');
  });

  it('says a code that exists is refused as a duplicate, and keeps the form so the code can be changed (AC-ST-PRJ-001-1)', async () => {
    const h = creating({}, () => problem('PROJECT_CODE_DUPLICATE'));
    mount(<ProjectCreateScreen route={ROUTE} />, h, { permissions: MAKER });
    await fill();
    submit();
    expect((await screen.findByRole('alert')).textContent).toBe(vi_['prj.problem.duplicateCode.error']);
    expect(screen.queryByTestId('created')).toBeNull();
    expect((screen.getByLabelText(vi_['prj.form.code.label']) as HTMLInputElement).value).toBe(' DA-NEW ');
  });

  it.each([
    [problem('MASTER_NOT_EFFECTIVE', 422, 'sector_master_version_id'), vi_['prj.problem.masterNotEffectiveField.error'].replace('{field}', 'sector_master_version_id')],
    [problem('VALIDATION_FAILED', 422, 'total_investment_vnd'), vi_['prj.problem.validationField.error'].replace('{field}', 'total_investment_vnd')],
    [problem('FIELD_NOT_ALLOWED', 400), vi_['prj.problem.notAllowed.error']],
    [problem('RESOURCE_NOT_FOUND', 404), vi_['prj.problem.notFound.error']],
    [problem('SCOPE_DENIED', 403), vi_['prj.problem.denied.error']],
    [new Error('boom'), vi_['prj.problem.general.error']],
  ])('tells the person why the command was refused (%#)', async (failure, message) => {
    mount(<ProjectCreateScreen route={ROUTE} />, creating({}, () => failure), { permissions: MAKER });
    await fill();
    submit();
    expect((await screen.findByRole('alert')).textContent).toBe(message);
  });

  it('is closed to a person without project.create and to a tenant that is read only', async () => {
    const h = creating();
    mount(<ProjectCreateScreen route={ROUTE} />, h, { permissions: READER });
    await ready().catch(() => undefined);
    expect(screen.getByText(vi_['prj.readOnly.denied.notice'])).toBeTruthy();
    expect((screen.getByRole('button', { name: vi_['prj.create.submit.action'] }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(screen.getByRole('form', { name: vi_['prj.create.form.title'] }));
    expect(h.command).not.toHaveBeenCalled();
    cleanup();
    mount(<ProjectCreateScreen route={ROUTE} />, creating(), { permissions: MAKER, mode: 'READ_ONLY' });
    expect(screen.getByText(vi_['prj.readOnly.frozen.notice'])).toBeTruthy();
  });

  it('says that the suggested group could not be read when the project was created but its read failed', async () => {
    mount(<ProjectCreateScreen route={ROUTE} />, creating({ details: [] }), { permissions: MAKER });
    await fill();
    submit();
    expect(await screen.findByText(vi_['prj.create.done.suggestionError'])).toBeTruthy();
  });
});
