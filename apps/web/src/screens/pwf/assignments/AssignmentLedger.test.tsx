import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeViolations, seriousViolations } from '../../../test/axe';
import { SessionContext, useSession } from '../../../session/SessionContext';
import { mount } from '../../sas/test-support';
import { ALL_PERMISSIONS, assignment, refusal, serve, text, uuid } from '../test/fixtures';
import { AssignmentLedger } from './AssignmentLedger';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const TASK = uuid(1002);
const MEMBERS = [
  { id: uuid(5), display_name: 'Trần Thị Bình', status: 'Active', membership_type: 'STAFF' },
  { id: uuid(6), display_name: 'Lê Văn Cường', status: 'Active' },
  { id: uuid(7), display_name: 'Đã nghỉ', status: 'Inactive' },
  { id: uuid(8), display_name: 'Khách', status: 'Active', membership_type: 'GUEST' },
];

const ReadOnly = ({ children }: { children: ReactNode }) => {
  const session = useSession();
  return <SessionContext.Provider value={{ ...session, mode: 'READ_ONLY' }}>{children}</SessionContext.Provider>;
};

interface Setup {
  page?: unknown;
  canAssign?: boolean;
  readOnly?: boolean;
  commands?: Record<string, unknown>;
  members?: unknown[] | Error;
}

const open = (setup: Setup = {}) => {
  const h = serve({ listProjectTaskAssignments: setup.page ?? { items: [assignment(1), assignment(2, { membership_id: uuid(5), display_name: 'Trần Thị Bình', role: 'CONSULTED', share_pct: 20, valid_to: '2027-03-31' })], next_cursor: null, as_of: '2026-11-12T03:00:00.000Z' } }, setup.commands ?? { assignProjectTask: { resource_id: uuid(9), status: 'OK' } });
  const members = setup.members ?? MEMBERS;
  (h.client.readAll as ReturnType<typeof vi.fn>).mockImplementation(() => (members instanceof Error ? Promise.reject(members) : Promise.resolve(members)));
  const ledger = <AssignmentLedger taskId={TASK} canAssign={setup.canAssign ?? true} />;
  mount(setup.readOnly === true ? <ReadOnly>{ledger}</ReadOnly> : ledger, h, ALL_PERMISSIONS);
  return h;
};

const change = (testId: string, value: string) => fireEvent.change(screen.getByTestId(testId), { target: { value } });
const fill = async (over: Record<string, string> = {}) => {
  await screen.findByTestId('assign-form');
  await waitFor(() => expect(screen.getByTestId('field-member').tagName).toBe('SELECT'));
  const values: Record<string, string> = { 'field-member': uuid(6), 'field-from': '2026-12-01', 'field-to': '', 'field-share': '50', 'field-reason': 'Giao theo vai của dự án', ...over };
  for (const [id, value] of Object.entries(values)) change(id, value);
};

describe('PWF-16: the ledger of a task', () => {
  it('lists who is assigned, in which role, over which days, with which share and why', async () => {
    open();
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Nguyễn Văn An')).toBeTruthy();
    expect(within(table).getByText(text('pwf.role.responsible.word'))).toBeTruthy();
    expect(within(table).getByText(text('pwf.role.consulted.word'))).toBeTruthy();
    expect(within(table).getByText('01/12/2026 – 31/03/2027')).toBeTruthy();
    expect(within(table).getByText(text('pwf.ledger.period.open', { from: '01/12/2026' }))).toBeTruthy();
    expect(within(table).getByText('100%')).toBeTruthy();
    expect(within(table).getAllByText('Giao theo vai của dự án')).toHaveLength(2);
    expect(screen.getByRole('button', { name: text('govc.bi.info.open', { name: text('pwf.ledger.share.name') }) })).toBeTruthy();
  });

  it('says so when nobody is assigned yet', async () => {
    open({ page: { items: [], next_cursor: null, as_of: '2026-11-12T03:00:00.000Z' } });
    expect((await screen.findByTestId('ledger-empty')).textContent).toBe(text('pwf.ledger.empty.text'));
  });

  it('shows the error state with a retry when the ledger cannot be read', async () => {
    open({ page: refusal('INTERNAL_ERROR', 500) });
    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  it('shows no form when the server says the caller cannot assign, nor in a read-only session', async () => {
    open({ canAssign: false });
    await screen.findByRole('table');
    expect(screen.queryByTestId('assign-form')).toBeNull();
    cleanup();
    open({ readOnly: true });
    await screen.findByRole('table');
    expect(screen.queryByTestId('assign-form')).toBeNull();
  });

  it('refuses to send a form with a problem and says it next to each field', async () => {
    const h = open();
    await screen.findByTestId('assign-form');
    fireEvent.click(screen.getByTestId('save'));
    expect(screen.getByTestId('error-member').textContent).toBe(text('pwf.form.pickOne.error'));
    expect(screen.getByTestId('error-from').textContent).toBe(text('pwf.form.required.error'));
    expect(screen.getByTestId('error-share').textContent).toBe(text('pwf.form.required.error'));
    expect(screen.getByTestId('error-reason').textContent).toBe(text('pwf.form.required.error'));
    expect(screen.getByTestId('field-share').getAttribute('aria-invalid')).toBe('true');
    expect(h.command).not.toHaveBeenCalled();
  });

  it('picks the person from the active staff, sends the assignment with a null end and clears the form', async () => {
    const h = open();
    await fill();
    const options = within(screen.getByTestId('field-member')).getAllByRole('option').map((option) => option.textContent);
    expect(options).toEqual([text('pwf.ledger.member.placeholder'), 'Trần Thị Bình', 'Lê Văn Cường']);
    change('field-role', 'ACCOUNTABLE');
    fireEvent.click(screen.getByTestId('save'));
    await screen.findByTestId('assign-saved');
    expect(h.command).toHaveBeenCalledWith('assignProjectTask', expect.objectContaining({ path: { task_id: TASK }, body: { membership_id: uuid(6), role: 'ACCOUNTABLE', valid_from: '2026-12-01', valid_to: null, share_pct: 50, reason: 'Giao theo vai của dự án' } }));
    expect((screen.getByTestId('field-reason') as HTMLTextAreaElement).value).toBe('');
  });

  it('asks for the id of the person when the list of staff cannot be read', async () => {
    const h = open({ members: new Error('no') });
    await screen.findByTestId('assign-form');
    const field = await screen.findByTestId('field-member');
    expect(field.tagName).toBe('INPUT');
    for (const [id, value] of Object.entries({ 'field-member': uuid(6), 'field-from': '2026-12-01', 'field-share': '50', 'field-reason': 'Giao theo vai của dự án' })) change(id, value);
    fireEvent.click(screen.getByTestId('save'));
    await screen.findByTestId('assign-saved');
    expect(h.command).toHaveBeenCalledTimes(1);
  });

  it('warns of an overlap and of more than 100 percent before sending, and still lets the server decide', async () => {
    const h = open();
    await fill({ 'field-member': uuid(5), 'field-role': 'CONSULTED', 'field-from': '2026-12-15', 'field-share': '90' });
    expect(screen.getByTestId('warn-overlap').textContent).toBe(text('pwf.ledger.warn.overlap.text'));
    expect(screen.getByTestId('warn-share').textContent).toBe(text('pwf.ledger.warn.share.text'));
    fireEvent.click(screen.getByTestId('save'));
    await screen.findByTestId('assign-saved');
    expect(h.command).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['PWF_ASSIGNMENT_INVALID', 'pwf.problem.assignmentInvalid.error'],
    ['SCOPE_DENIED', 'pwf.problem.denied.error'],
  ])('tells the refusal %s in words', async (code, key) => {
    open({ commands: { assignProjectTask: refusal(code, 422) } });
    await fill();
    fireEvent.click(screen.getByTestId('save'));
    expect((await screen.findByTestId('problem')).textContent).toContain(text(key));
    expect(screen.queryByTestId('assign-saved')).toBeNull();
  });

  it('has no serious accessibility violation', async () => {
    open();
    await screen.findByTestId('assign-form');
    expect(describeViolations(await seriousViolations(document.body))).toEqual([]);
  });
});
