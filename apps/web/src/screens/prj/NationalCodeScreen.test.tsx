import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import NationalCodeScreen from './NationalCodeScreen';
import { client, line, mount, routeOf, world } from './test-support';

const ROUTE = routeOf('PRJ-21', 'FR-PRJ-21');
const MANAGER = ['project.read', 'project.national_code.manage'];
const READER = ['project.read'];
const problem = (code: string, status = 422) => new ApiError({ status, code, correlationId: 'c', extensions: {} });
const OK = { operation_id: 'o', status: 'BUDGETED', resource_version: 2, resource_id: line(1).id };
const DOCUMENT = '00000000-0000-4000-8000-000000000900';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const worldOf = () =>
  world({
    projects: [
      line(1, { status: 'BUDGETED' }),
      line(2, { status: 'IMPLEMENTATION', national_project_code: '7654321', project_group: 'B' }),
      line(3, { status: 'CLOSED', national_project_code: null, project_group: 'B' }),
      line(4, { status: 'PIPELINE', project_group: 'B', name: 'Đường tỉnh lộ' }),
    ],
  });
const rowOf = (n: number): HTMLElement => document.querySelector(`[data-project-id="${line(n).id}"]`) as HTMLElement;
const ready = () => screen.findByTestId('projects');
const open = (n: number) => fireEvent.click(within(rowOf(n)).getByRole('button'));
const fill = (label: string, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};
const save = (): void => {
  fireEvent.click(screen.getByRole('button', { name: vi_['prj.reconcile.dialog.submit.action'] }));
};

describe('NationalCodeScreen (PRJ-21): the national project codes of the register', () => {
  it('AC-ST-PRJ-004-3, UI-PRJ-21: shows the adapter as PROPOSED with its manual-file wording, and makes no outbound call when it opens', async () => {
    const fetched = vi.spyOn(globalThis, 'fetch');
    const h = client(worldOf());
    mount(<NationalCodeScreen route={ROUTE} />, h, { permissions: MANAGER, path: '/prj/prj-21' });
    await ready();
    expect(screen.getByTestId('adapter-badge').textContent).toBe(vi_['prj.reconcile.adapter.badge']);
    expect(vi_['prj.reconcile.adapter.badge']).toContain('Adapter: PROPOSED');
    expect(screen.getByTestId('adapter-note').textContent).toBe(vi_['prj.reconcile.adapter.note']);
    // The screen reads the register and writes nothing: no command, no other read, no request to a system outside the application.
    expect(h.command).not.toHaveBeenCalled();
    expect(h.read).not.toHaveBeenCalled();
    expect(fetched).not.toHaveBeenCalled();
  });

  it('UI-PRJ-21: lists the projects without a code first, says how many there are, and shows each project with its code, stage and reconciliation state', async () => {
    mount(<NationalCodeScreen route={ROUTE} />, client(worldOf()), { permissions: MANAGER, path: '/prj/prj-21' });
    await ready();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['prj.reconcile.page.title']);
    expect(screen.getByTestId('missing-count').textContent).toBe(vi_['prj.reconcile.missing.count'].replace('{count}', '3'));
    expect(Array.from(document.querySelectorAll('[data-project-id]')).map((tr) => tr.querySelector('th')?.textContent)).toEqual(['DA-2026-001', 'DA-2026-003', 'DA-2026-004']);
    expect(within(rowOf(1)).getByTestId('national-code-missing').textContent).toBe(vi_['prj.nationalCode.missing.badge']);
    expect(within(rowOf(1)).getByTestId('state').textContent).toBe(vi_['prj.reconcile.state.missing.label']);
    fireEvent.click(screen.getByLabelText(vi_['prj.reconcile.missingOnly.label']));
    expect(within(rowOf(2)).getByTestId('national-code').textContent).toBe('7654321');
    expect(within(rowOf(2)).getByTestId('state').textContent).toBe(vi_['prj.reconcile.state.hasCode.label']);
    fireEvent.change(screen.getByLabelText(vi_['prj.reconcile.query.label']), { target: { value: 'tỉnh lộ' } });
    expect(Array.from(document.querySelectorAll('[data-project-id]'))).toHaveLength(1);
    fireEvent.change(screen.getByLabelText(vi_['prj.reconcile.query.label']), { target: { value: 'không có' } });
    expect(screen.getByTestId('no-match').textContent).toBe(vi_['prj.reconcile.noMatch.notice']);
  });

  it('AC-ST-PRJ-004-1: assigns the code of a project by hand under the version of the project and closes the dialog', async () => {
    const h = client(worldOf(), () => OK);
    mount(<NationalCodeScreen route={ROUTE} />, h, { permissions: MANAGER, path: '/prj/prj-21' });
    await ready();
    open(1);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByTestId('current-code').textContent).toBe(vi_['prj.reconcile.dialog.current.none']);
    save();
    expect(h.command).not.toHaveBeenCalled();
    expect(within(dialog).getByRole('alert').textContent).toBe(vi_['prj.reconcile.field.codeRequired.error']);
    fill(vi_['prj.reconcile.dialog.code.label'], ' 7000001 ');
    save();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(h.command).toHaveBeenCalledWith('assignNationalProjectCode', expect.objectContaining({ path: { id: line(1).id }, ifMatchVersion: 1, body: { national_project_code: '7000001' } }));
  });

  it('AC-ST-PRJ-004-1: changing the code of a project under way asks for the document that grounds it, and sends it in lower case', async () => {
    const h = client(worldOf(), () => OK);
    mount(<NationalCodeScreen route={ROUTE} />, h, { permissions: MANAGER, path: '/prj/prj-21' });
    await ready();
    fireEvent.click(screen.getByLabelText(vi_['prj.reconcile.missingOnly.label']));
    open(2);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByTestId('current-code').textContent).toBe(vi_['prj.reconcile.dialog.current.text'].replace('{code}', '7654321'));
    expect(dialog.textContent).toContain(vi_['prj.reconcile.dialog.evidence.required']);
    fill(vi_['prj.reconcile.dialog.code.label'], '7000002');
    save();
    expect(h.command).not.toHaveBeenCalled();
    expect(within(dialog).getByRole('alert').textContent).toBe(vi_['prj.reconcile.field.evidenceRequired.error']);
    fill(vi_['prj.reconcile.dialog.evidence.label'], 'nope');
    save();
    expect(within(dialog).getByRole('alert').textContent).toBe(vi_['prj.reconcile.field.evidenceInvalid.error']);
    fill(vi_['prj.reconcile.dialog.evidence.label'], DOCUMENT.toUpperCase());
    save();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(h.command).toHaveBeenCalledWith('assignNationalProjectCode', expect.objectContaining({ body: { national_project_code: '7000002', evidence_document_id: DOCUMENT } }));
  });

  it('AC-ST-PRJ-004-1: checks the code before it is sent: too long, with a control character', async () => {
    const h = client(worldOf(), () => OK);
    mount(<NationalCodeScreen route={ROUTE} />, h, { permissions: MANAGER, path: '/prj/prj-21' });
    await ready();
    open(1);
    fill(vi_['prj.reconcile.dialog.code.label'], 'x'.repeat(51));
    save();
    expect(screen.getByRole('dialog').querySelector('[role="alert"]')?.textContent).toBe(vi_['prj.reconcile.field.codeTooLong.error']);
    fill(vi_['prj.reconcile.dialog.code.label'], 'a\u0007b');
    save();
    expect(screen.getByRole('dialog').querySelector('[role="alert"]')?.textContent).toBe(vi_['prj.reconcile.field.codeInvalid.error']);
    expect(h.command).not.toHaveBeenCalled();
  });

  it('AC-ST-PRJ-004-1: tells why the server refused the code and keeps the dialog open: format, duplicate, ground, stage, version', async () => {
    const cases: Array<[string, number, string]> = [
      ['NATIONAL_CODE_FORMAT_INVALID', 422, 'prj.reconcile.problem.formatInvalid.error'],
      ['NATIONAL_CODE_DUPLICATE', 409, 'prj.reconcile.problem.duplicate.error'],
      ['DECISION_REQUIRED', 422, 'prj.reconcile.problem.evidenceRequired.error'],
      ['STAGE_LOCKED_FIELD', 422, 'prj.reconcile.problem.stageLocked.error'],
      ['VERSION_CONFLICT', 409, 'prj.reconcile.problem.versionConflict.error'],
      ['VALIDATION_FAILED', 422, 'prj.reconcile.problem.validation.error'],
      ['RESOURCE_NOT_FOUND', 404, 'prj.reconcile.problem.notFound.error'],
      ['SCOPE_DENIED', 403, 'prj.reconcile.problem.denied.error'],
      ['SOMETHING_ELSE', 500, 'prj.reconcile.problem.general.error'],
    ];
    for (const [code, status, key] of cases) {
      const h = client(worldOf(), () => problem(code, status));
      const view = mount(<NationalCodeScreen route={ROUTE} />, h, { permissions: MANAGER, path: '/prj/prj-21' });
      await ready();
      open(1);
      fill(vi_['prj.reconcile.dialog.code.label'], '7000001');
      save();
      expect((await screen.findByTestId('refusal')).textContent).toBe(vi_[key as keyof typeof vi_]);
      expect(screen.getByRole('dialog')).toBeTruthy();
      view.unmount();
    }
  });

  it('closes the dialog without a command when it is cancelled, and offers no action for a project that has ended', async () => {
    const h = client(worldOf(), () => OK);
    mount(<NationalCodeScreen route={ROUTE} />, h, { permissions: MANAGER, path: '/prj/prj-21' });
    await ready();
    expect(within(rowOf(3)).queryByRole('button')).toBeNull();
    open(1);
    fireEvent.click(screen.getByRole('button', { name: vi_['prj.reconcile.dialog.cancel.action'] }));
    expect(screen.queryByRole('dialog')).toBeNull();
    open(1);
    fireEvent.click(screen.getByRole('button', { name: vi_['prj.reconcile.dialog.close.label'] }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('AC-ST-PRJ-004-2: shows the import panel of the reconciliation file, which uploads nothing until the officer chooses a file, and refuses it to someone who only reads', async () => {
    const h = client(worldOf());
    const manager = mount(<NationalCodeScreen route={ROUTE} />, h, { permissions: MANAGER, path: '/prj/prj-21' });
    await ready();
    const panel = screen.getByTestId('import-panel');
    expect(within(panel).getByText(vi_['prj.reconcile.import.layout.note'])).toBeTruthy();
    expect(within(panel).getByRole('button', { name: vi_['prj.reconcile.import.check.action'] })).toHaveProperty('disabled', true);
    expect(h.command).not.toHaveBeenCalled();
    manager.unmount();
    mount(<NationalCodeScreen route={ROUTE} />, client(worldOf()), { permissions: READER, path: '/prj/prj-21' });
    await ready();
    expect(screen.getByTestId('import-denied').textContent).toBe(vi_['prj.reconcile.import.denied.notice']);
  });

  it('offers no assignment to someone who only reads, nor in a read-only session', async () => {
    const reader = mount(<NationalCodeScreen route={ROUTE} />, client(worldOf()), { permissions: READER, path: '/prj/prj-21' });
    await ready();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByTestId('adapter-badge')).toBeTruthy();
    reader.unmount();
    mount(<NationalCodeScreen route={ROUTE} />, client(worldOf()), { permissions: MANAGER, mode: 'READ_ONLY', path: '/prj/prj-21' });
    await ready();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('says that the register could not be read, and reads it again on a retry', async () => {
    const state = world({ failing: new Set(['get_resources_project']) });
    mount(<NationalCodeScreen route={ROUTE} />, client(state), { permissions: MANAGER, path: '/prj/prj-21' });
    const retry = await screen.findByRole('button', { name: vi_['states.retry.action'] });
    state.failing = new Set();
    await userEvent.setup().click(retry);
    await waitFor(() => expect(screen.getByTestId('projects')).toBeTruthy());
  });
});
