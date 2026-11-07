import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import ProjectListScreen from './ProjectListScreen';
import { MAKER, READER, client, line, mount, routeOf, word, words, world } from './test-support';

const ROUTE = routeOf('PRJ-01', 'FR-PRJ-01');

afterEach(cleanup);

// The rows of the table of the kit: the rows of the body that hold cells (the head holds column headers only).
const rows = (): HTMLElement[] => screen.queryAllByRole('row').filter((row) => within(row).queryAllByRole('cell').length > 0 && row.closest('tbody') !== null);
const codes = (): string[] =>
  rows().flatMap((row) =>
    within(row)
      .queryAllByRole('link')
      .slice(0, 1)
      .map((link) => link.textContent ?? ''),
  );
const ready = () => waitFor(() => expect(rows().length).toBeGreaterThan(0));

describe('ProjectListScreen (PRJ-01): the register of the unit tree of the caller', () => {
  it('lists each project with its stage, its national code, its group and its leader, and shows a missing code as a textual badge (UI-PRJ-01, AC-ST-PRJ-001-5)', async () => {
    mount(<ProjectListScreen route={ROUTE} />, client(world()), { permissions: READER });
    await ready();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['prj.list.page.title']);
    expect(codes()).toEqual(['DA-2026-001', 'DA-2026-002']);
    const headers = screen.getAllByRole('columnheader').map((cell) => cell.textContent);
    expect(headers).toEqual([
      words['prj.list.column.project'],
      words['prj.list.column.investor'],
      words['prj.list.column.group'],
      words['prj.list.column.status'],
      words['prj.list.column.nationalCode'],
      words['prj.list.column.leader'],
    ]);
    const cells = (index: number) => Array.from(rows()[index]?.querySelectorAll('td') ?? []).map((cell) => cell.textContent);
    // The project cell reads the code, the name and the stage as a pill with its words; the first project has no national code: the badge says so in words.
    expect(cells(0)).toEqual([
      `DA-2026-001Dự án số 1${vi_['prj.stage.concept.label']}`,
      'Ban QLDA tỉnh',
      vi_['prj.list.group.none'],
      vi_['prj.life.open.label'],
      vi_['prj.nationalCode.missing.badge'],
      vi_['prj.list.leader.none'],
    ]);
    expect(cells(1)).toEqual([`DA-2026-002Dự án số 2${vi_['prj.stage.implementation.label']}`, 'Ban QLDA tỉnh', 'B', vi_['prj.life.open.label'], '7654321', 'Nguyễn Văn An']);
    expect(rows()[0]?.querySelector('[data-testid="stage"]')?.textContent).toBe(vi_['prj.stage.concept.label']);
    expect(rows()[0]?.querySelector('[data-testid="national-code-missing"]')?.textContent).toBe(vi_['prj.nationalCode.missing.badge']);
    expect(rows()[1]?.querySelector('[data-testid="national-code"]')?.textContent).toBe('7654321');
    expect(rows()[0]?.querySelector('a')?.getAttribute('href')).toBe(`/prj/prj-03?id=${line(1).id}`);
  });

  it('falls back to the owner unit when a project has no investor, and says an ended project is ended', async () => {
    const state = world({ projects: [line(3, { investor_unit_id: null, investor_unit_name: null, status: 'CANCELLED' })] });
    mount(<ProjectListScreen route={ROUTE} />, client(state), { permissions: READER });
    await ready();
    const cells = Array.from(rows()[0]?.querySelectorAll('td') ?? []).map((cell) => cell.textContent);
    expect(cells[1]).toBe('Sở Giao thông');
    expect(cells[3]).toBe(vi_['prj.life.ended.label']);
  });

  it('filters by code or name, by stage and by a missing national code, and says when nothing matches', async () => {
    mount(<ProjectListScreen route={ROUTE} />, client(world()), { permissions: READER });
    await ready();
    fireEvent.change(screen.getByLabelText(vi_['prj.list.query.label']), { target: { value: 'số 2' } });
    expect(codes()).toEqual(['DA-2026-002']);
    fireEvent.change(screen.getByLabelText(vi_['prj.list.query.label']), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText(vi_['prj.list.stage.label']), { target: { value: 'CONCEPT' } });
    expect(codes()).toEqual(['DA-2026-001']);
    fireEvent.change(screen.getByLabelText(vi_['prj.list.stage.label']), { target: { value: '' } });
    fireEvent.click(screen.getByLabelText(vi_['prj.list.missingCode.label']));
    expect(codes()).toEqual(['DA-2026-001']);
    fireEvent.change(screen.getByLabelText(vi_['prj.list.stage.label']), { target: { value: 'CLOSED' } });
    expect(within(screen.getByTestId('projects')).getByRole('status').textContent).toContain(vi_['ui.dataTable.emptyFiltered']);
  });

  it('clears a filter that found nothing from the empty state of the table', async () => {
    mount(<ProjectListScreen route={ROUTE} />, client(world()), { permissions: READER });
    await ready();
    fireEvent.change(screen.getByLabelText(vi_['prj.list.stage.label']), { target: { value: 'CLOSED' } });
    expect(codes()).toEqual([]);
    await userEvent.setup().click(screen.getByRole('button', { name: vi_['ui.dataTable.clearFilters'] }));
    expect(codes()).toEqual(['DA-2026-001', 'DA-2026-002']);
    expect((screen.getByLabelText(vi_['prj.list.stage.label']) as HTMLSelectElement).value).toBe('');
  });

  it('pages a long register inside the table and goes back to the first page when a filter changes', async () => {
    const projects = Array.from({ length: 25 }, (_, index) => line(index + 1));
    mount(<ProjectListScreen route={ROUTE} />, client(world({ projects })), { permissions: READER });
    await ready();
    expect(rows()).toHaveLength(20);
    expect(screen.getByText(word('ui.tablePager.range').replace('{from}', '1').replace('{to}', '20').replace('{total}', '25'))).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('button', { name: word('ui.tablePager.page').replace('{page}', '2') }));
    expect(rows()).toHaveLength(5);
    expect(codes()[0]).toBe('DA-2026-0021');
    fireEvent.change(screen.getByLabelText(vi_['prj.list.query.label']), { target: { value: 'số 2' } });
    expect(screen.getByRole('button', { name: word('ui.tablePager.page').replace('{page}', '1') }).getAttribute('aria-current')).toBe('page');
  });

  it('offers the creation to those who may create, and not to a reader or to a tenant that is read only', async () => {
    mount(<ProjectListScreen route={ROUTE} />, client(world()), { permissions: MAKER });
    await ready();
    expect(screen.getByRole('link', { name: vi_['prj.list.create.action'] }).getAttribute('href')).toBe('/prj/prj-02');
    cleanup();
    mount(<ProjectListScreen route={ROUTE} />, client(world()), { permissions: READER });
    await ready();
    expect(screen.queryByRole('link', { name: vi_['prj.list.create.action'] })).toBeNull();
    cleanup();
    mount(<ProjectListScreen route={ROUTE} />, client(world()), { permissions: MAKER, mode: 'READ_ONLY' });
    await ready();
    expect(screen.queryByRole('link', { name: vi_['prj.list.create.action'] })).toBeNull();
  });

  it('shows the empty state when the register has no project in the scope of the caller', async () => {
    mount(<ProjectListScreen route={ROUTE} />, client(world({ projects: [] })), { permissions: READER });
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
  });

  it('says that the register could not be read, with a retry, and that the scope refused it', async () => {
    const state = world({ failing: new Set(['get_resources_project']) });
    mount(<ProjectListScreen route={ROUTE} />, client(state), { permissions: READER });
    expect(await screen.findByRole('alert')).toBeTruthy();
    state.failing = new Set();
    await userEvent.setup().click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
    await ready();
    expect(codes().length).toBe(2);
    cleanup();
    const h = client(world());
    (h.client as unknown as { readAll: () => Promise<unknown[]> }).readAll = () => Promise.reject(new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c', extensions: {} }));
    mount(<ProjectListScreen route={ROUTE} />, h, { permissions: READER });
    expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
  });
});
