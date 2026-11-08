import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { translator } from '../../../i18n';
import MonitoringListScreen from './MonitoringListScreen';
import { MANAGER, READER, fileList, harness, listItem, mount, never, notice, problem, routeOf, word, FILE_ID, PROJECT_ID } from './test/support';

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
  vi.restoreAllMocks();
});

const route = routeOf('PRJ-30', 'FR-PRJ-30');
const show = (answer: (op: string, input: unknown) => unknown, permissions = MANAGER, command?: (op: string, input: unknown) => unknown) => {
  const h = harness(answer, command);
  const view = mount(<MonitoringListScreen route={route} />, h, { permissions });
  return { h, view };
};

describe('PRJ-30, the community monitoring files', () => {
  it('UI-PRJ-30: lists the project, the day the duty began, the deadline, the state of the notice and the late feedback', async () => {
    show(() => fileList([listItem({ notice: notice({ state: 'OVERDUE', days_left: -23 }) })]));
    expect(await screen.findByTestId(`file-${FILE_ID}`)).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(word('prj.monList.page.title'));
    expect(screen.getByTestId(`due-${FILE_ID}`).textContent).toBe('15/02/2027');
    expect(screen.getByText(word('prj.common.notice.overdue'))).toBeTruthy();
    expect(screen.getByTestId(`overdue-${FILE_ID}`).textContent).toBe('1');
    expect(screen.getByText(word('prj.mon.trigger.worksStart'), { exact: false })).toBeTruthy();
    expect(screen.getByTestId('unverified-note').textContent).toBe(word('prj.monList.unverified'));
  });

  it('puts an "i" on the deadline: formula with the days fixed on the file, source, day, version and "default, not confirmed"', async () => {
    show(() => fileList([listItem()]));
    await screen.findByTestId(`due-${FILE_ID}`);
    fireEvent.click(screen.getAllByRole('button', { name: new RegExp(word('prj.mon.info.notice.name')) })[0] as HTMLElement);
    const panel = await screen.findByRole('dialog', { name: word('prj.mon.info.notice.name') });
    expect(within(panel).getByText(/45/)).toBeTruthy();
    expect(within(panel).getByText(word('prj.mon.info.notice.source'))).toBeTruthy();
    expect(within(panel).getByText(word('prj.info.version.default'))).toBeTruthy();
    expect(within(panel).getByText(word('prj.info.panel.unverified'))).toBeTruthy();
  });

  it('offers to open a file only to someone who may manage, and sends the project with an idempotent command', async () => {
    const { h } = show(() => fileList([listItem()]), MANAGER, () => ({ resource_id: FILE_ID, status: 'OPENED' }));
    fireEvent.click(await screen.findByTestId('open-file'));
    fireEvent.change(await screen.findByTestId('open-project'), { target: { value: 'not an id' } });
    fireEvent.click(screen.getByRole('button', { name: word('prj.monList.open.confirm') }));
    expect((await screen.findByRole('alert')).textContent).toContain(word('prj.common.error.validationFailed'));
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('open-project'), { target: { value: PROJECT_ID.toUpperCase() } });
    fireEvent.click(screen.getByRole('button', { name: word('prj.monList.open.confirm') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('openMonitoringFile', expect.objectContaining({ body: { project_id: PROJECT_ID }, attempt: expect.anything() })));
  });

  it('hides the button from a reader', async () => {
    show(() => fileList([listItem()]), READER);
    await screen.findByTestId(`file-${FILE_ID}`);
    expect(screen.queryByTestId('open-file')).toBeNull();
  });

  it('shows a refusal in words in the dialog', async () => {
    show(() => fileList([listItem()]), MANAGER, () => problem('SCOPE_DENIED', 403));
    fireEvent.click(await screen.findByTestId('open-file'));
    fireEvent.change(await screen.findByTestId('open-project'), { target: { value: PROJECT_ID } });
    fireEvent.click(screen.getByRole('button', { name: word('prj.monList.open.confirm') }));
    expect((await screen.findByRole('alert')).textContent).toContain(word('prj.common.error.scopeDenied'));
  });

  it('asks the server for the status that was chosen', async () => {
    const { h } = show(() => fileList([listItem()]));
    await screen.findByTestId(`file-${FILE_ID}`);
    fireEvent.change(screen.getByTestId('filter-status'), { target: { value: 'CLOSED' } });
    await waitFor(() => expect(h.read).toHaveBeenLastCalledWith('listMonitoringFiles', expect.objectContaining({ query: expect.objectContaining({ status: 'CLOSED' }) })));
  });

  it('shows the loading, empty, error, denied and offline states and says when a refresh failed', async () => {
    show(() => never());
    expect(await screen.findByRole('status', { name: word('states.loading.label') })).toBeTruthy();
    cleanup();
    show(() => fileList([]));
    expect(await screen.findByText(word('states.empty.title'))).toBeTruthy();
    cleanup();
    show(() => problem('INTERNAL_ERROR', 500));
    expect(await screen.findByText(word('states.error.title'))).toBeTruthy();
    cleanup();
    show(() => problem('SCOPE_DENIED', 403));
    expect(await screen.findByText(word('states.denied.title'))).toBeTruthy();
    cleanup();
    let calls = 0;
    const { view } = show(() => {
      calls += 1;
      return calls === 1 ? fileList([listItem()]) : problem('INTERNAL_ERROR', 500);
    });
    await screen.findByTestId(`file-${FILE_ID}`);
    await view.queries.invalidateQueries();
    expect(await screen.findByText(new RegExp(word('ui.contextBar.stale')))).toBeTruthy();
    expect(screen.getByTestId(`file-${FILE_ID}`)).toBeTruthy();
  });

  it('links each file to its detail', async () => {
    show(() => fileList([listItem()]));
    const link = await screen.findByTestId(`file-${FILE_ID}`);
    expect(link.getAttribute('href')).toBe(`/prj/prj-31?file=${FILE_ID}`);
  });
});
