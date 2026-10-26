import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { PLAN_READER, PROJECT, UNIT_XA, client, complaintRecord, household, mount, planRecord, routeOf, world } from '../test-support';
import { todayInVietnam } from '../model';
import ComplaintScreen from './ComplaintScreen';

const ROUTE = routeOf('LND-08', 'FR-LND-08');
const PATH = `/lnd/lnd-08?project=${PROJECT}`;
const OK = { operation_id: 'o', status: 'RECEIVED', resource_version: 1, resource_id: complaintRecord(1).id };
const problem = (code: string, status = 422) => new ApiError({ status, code, correlationId: 'c', extensions: {} });
const OFFICER = ['land.complaint.write', 'land.complaint.resolve', 'land.read'];
const FILER = ['land.complaint.write', 'land.read'];
const RESOLVER = ['land.complaint.resolve', 'land.read'];
const DOCUMENT = '00000000-0000-4000-8000-000000000e01';
const TODAY = todayInVietnam();

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const worldOf = () =>
  world({
    households: [household(1), household(2, { household_code: 'HH-000002' })],
    plans: [planRecord(1, { plan_code: 'PA-0001' })],
    complaints: [
      complaintRecord(1),
      complaintRecord(2, { household_code: 'HH-000002', subject: 'AREA', channel: 'LETTER', status: 'UNDER_REVIEW', remaining_days: -3, description: 'Diện tích đo sai' }),
      complaintRecord(3, { status: 'RESOLVED_ACCEPTED', remaining_days: null, resolved_on: '2026-10-10', resolution_note: 'Đã đo lại', resolution_document_version_id: DOCUMENT, issue_id: '00000000-0000-4000-8000-000000000f01', version: 2 }),
      complaintRecord(4, { status: 'ESCALATED', remaining_days: null, resolved_on: '2026-10-12', resolution_note: 'Đã chuyển lên huyện', version: 2 }),
    ],
  });
const rowOf = (n: number): HTMLElement => document.querySelector(`[data-complaint-id="${complaintRecord(n).id}"]`) as HTMLElement;
const ready = () => screen.findByTestId('complaints');
const resolveButton = (row: HTMLElement, number: string) => within(row).getByRole('button', { name: vi_['lnd.complaints.resolve.aria'].replace('{number}', number) });

describe('ComplaintScreen (LND-08): the complaints of the households', () => {
  it('UI-LND-08: asks for a project first and lists the complaints of the one chosen', async () => {
    mount(<ComplaintScreen route={ROUTE} />, client(worldOf()), { permissions: OFFICER, path: '/lnd/lnd-08' });
    expect((await screen.findByTestId('choose-project')).textContent).toBe(vi_['lnd.complaints.project.notice']);
    expect(screen.queryByRole('button', { name: vi_['lnd.complaints.file.action'] })).toBeNull();
    await screen.findByRole('option', { name: /DA-2026-001/ });
    fireEvent.change(screen.getByLabelText(vi_['lnd.complaints.project.label']), { target: { value: PROJECT } });
    await ready();
    expect(Array.from(document.querySelectorAll('[data-complaint-id]'))).toHaveLength(4);
    expect(screen.getByRole('button', { name: vi_['lnd.complaints.file.action'] })).toBeTruthy();
    fireEvent.change(screen.getByLabelText(vi_['lnd.complaints.project.label']), { target: { value: '' } });
    expect(screen.getByTestId('choose-project')).toBeTruthy();
  });

  it('UI-LND-08, UAT-AC384: shows the number and the way it came, the household, what it is about and says, the day it is to be answered by and the days left or past, the status, the reply and the linked issue', async () => {
    mount(<ComplaintScreen route={ROUTE} />, client(worldOf()), { permissions: PLAN_READER, path: PATH });
    await ready();
    const waiting = rowOf(1);
    expect(within(waiting).getByTestId('number').textContent).toContain('LC-000001');
    expect(within(waiting).getByTestId('number').textContent).toContain(vi_['lnd.complaintChannel.meeting.label']);
    expect(within(waiting).getByTestId('household').textContent).toBe('HH-000001');
    expect(within(waiting).getByTestId('subject').textContent).toBe(vi_['lnd.complaintSubject.price.label']);
    expect(within(waiting).getByTestId('description').textContent).toContain('Giá nhà quá thấp so với thị trường');
    expect(within(waiting).getByTestId('due').textContent).toContain('2026-10-15');
    expect(within(waiting).getByTestId('left').textContent).toBe('Còn 5 ngày');
    expect(within(waiting).getByTestId('status').textContent).toBe(vi_['lnd.complaintStatus.received.label']);
    expect(within(waiting).getByTestId('issue').textContent).toBe(vi_['lnd.complaints.value.none']);
    expect(within(rowOf(2)).getByTestId('left').textContent).toBe('Quá hạn 3 ngày');
    expect(within(rowOf(2)).getByTestId('status').textContent).toBe(vi_['lnd.complaintStatus.underReview.label']);
    const answered = rowOf(3);
    expect(within(answered).getByTestId('resolution').textContent).toBe(vi_['lnd.complaints.row.resolution'].replace('{date}', '2026-10-10').replace('{note}', 'Đã đo lại'));
    expect(within(answered).queryByTestId('left')).toBeNull();
    expect(within(answered).getByTestId('issue').textContent).toBe('00000000-0000-4000-8000-000000000f01');
    expect(within(rowOf(4)).getByTestId('status').textContent).toBe(vi_['lnd.complaintStatus.escalated.label']);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('filters the complaints by status and says so when none has it or the project has none', async () => {
    mount(<ComplaintScreen route={ROUTE} />, client(worldOf()), { permissions: PLAN_READER, path: PATH });
    await ready();
    fireEvent.change(screen.getByLabelText(vi_['lnd.complaints.status.label']), { target: { value: 'ESCALATED' } });
    expect(Array.from(document.querySelectorAll('[data-complaint-id]'))).toHaveLength(1);
    fireEvent.change(screen.getByLabelText(vi_['lnd.complaints.status.label']), { target: { value: 'CLOSED' } });
    expect((await screen.findByTestId('no-match')).textContent).toBe(vi_['lnd.complaints.noMatch.notice']);
    cleanup();
    mount(<ComplaintScreen route={ROUTE} />, client(world()), { permissions: PLAN_READER, path: PATH });
    expect((await screen.findByTestId('no-match')).textContent).toBe(vi_['lnd.complaints.empty.notice']);
  });

  it('AC-ST-LND-008-1, UI-LND-08: files a complaint of a household with the way it came, what it is about, what it says and the day, naming the unit of the household', async () => {
    const h = client(worldOf(), () => OK);
    mount(<ComplaintScreen route={ROUTE} />, h, { permissions: FILER, path: PATH });
    await ready();
    expect(screen.queryByRole('button', { name: vi_['lnd.complaints.resolve.aria'].replace('{number}', 'LC-000001') })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: vi_['lnd.complaints.file.action'] }));
    const dialog = screen.getByRole('dialog');
    await within(dialog).findByRole('option', { name: 'HH-000002' });
    expect((within(dialog).getByLabelText(vi_['lnd.complaints.fileDialog.date.label']) as HTMLInputElement).value).toBe(TODAY);
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    expect(within(dialog).getAllByText(vi_['lnd.field.required.error']).length).toBe(4);
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.complaints.fileDialog.date.label']), { target: { value: '2999-01-01' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.complaints.fileDialog.description.label']), { target: { value: 'a\u0007b' } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    expect(within(dialog).getByText(vi_['lnd.complaints.field.future.error'])).toBeTruthy();
    expect(within(dialog).getByText(vi_['lnd.field.invalid.error'])).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.complaints.fileDialog.description.label']), { target: { value: 'x'.repeat(2001) } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    expect(within(dialog).getByText(vi_['lnd.field.tooLong.error'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.complaints.fileDialog.household.label']), { target: { value: household(2).id } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.complaints.fileDialog.channel.label']), { target: { value: 'LETTER' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.complaints.fileDialog.subject.label']), { target: { value: 'AREA' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.complaints.fileDialog.date.label']), { target: { value: '2026-09-15' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.complaints.fileDialog.description.label']), { target: { value: '  Diện tích đo sai  ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(h.command).toHaveBeenCalledWith('fileLandComplaint', expect.objectContaining({ body: { project_id: PROJECT, household_id: household(2).id, owner_unit_id: UNIT_XA, channel: 'LETTER', subject: 'AREA', description: 'Diện tích đo sai', filed_on: '2026-09-15' } }));
  });

  it('names a plan of the project when the complaint is about one', async () => {
    const h = client(worldOf(), () => OK);
    mount(<ComplaintScreen route={ROUTE} />, h, { permissions: FILER, path: PATH });
    await ready();
    fireEvent.click(screen.getByRole('button', { name: vi_['lnd.complaints.file.action'] }));
    const dialog = screen.getByRole('dialog');
    await within(dialog).findByRole('option', { name: 'HH-000001' });
    await within(dialog).findByRole('option', { name: /PA-0001/ });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.complaints.fileDialog.household.label']), { target: { value: household(1).id } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.complaints.fileDialog.plan.label']), { target: { value: planRecord(1).id } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.complaints.fileDialog.channel.label']), { target: { value: 'PORTAL' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.complaints.fileDialog.subject.label']), { target: { value: 'OTHER' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.complaints.fileDialog.description.label']), { target: { value: 'Khác' } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command).toHaveBeenCalledWith('fileLandComplaint', expect.objectContaining({ body: expect.objectContaining({ plan_id: planRecord(1).id, household_id: household(1).id, subject: 'OTHER', channel: 'PORTAL' }) }));
  });

  it('AC-ST-LND-008-1, UAT-AC384, UI-LND-08: answers a complaint with an outcome, a day, a note and, for an acceptance or a rejection, the reply document, under its version', async () => {
    const h = client(worldOf(), () => ({ ...OK, status: 'RESOLVED_ACCEPTED', resource_version: 2 }));
    mount(<ComplaintScreen route={ROUTE} />, h, { permissions: RESOLVER, path: PATH });
    await ready();
    expect(screen.queryByRole('button', { name: vi_['lnd.complaints.file.action'] })).toBeNull();
    expect(within(rowOf(3)).queryByRole('button')).toBeNull();
    fireEvent.click(resolveButton(rowOf(1), 'LC-000001'));
    const dialog = screen.getByRole('dialog');
    expect((within(dialog).getByLabelText(vi_['lnd.complaints.resolveDialog.date.label']) as HTMLInputElement).value).toBe(TODAY);
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    expect(within(dialog).getAllByText(vi_['lnd.field.required.error']).length).toBe(2);
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.complaints.resolveDialog.outcome.label']), { target: { value: 'RESOLVED_ACCEPTED' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.complaints.resolveDialog.date.label']), { target: { value: '2026-09-01' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.complaints.resolveDialog.document.label']), { target: { value: 'nope' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.complaints.resolveDialog.note.label']), { target: { value: 'a\u0007b' } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    expect(within(dialog).getByText(vi_['lnd.complaints.field.early.error'])).toBeTruthy();
    expect(within(dialog).getAllByText(vi_['lnd.field.invalid.error']).length).toBe(2);
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.complaints.resolveDialog.date.label']), { target: { value: '2999-01-01' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.complaints.resolveDialog.document.label']), { target: { value: '' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.complaints.resolveDialog.note.label']), { target: { value: 'x'.repeat(2001) } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    expect(within(dialog).getByText(vi_['lnd.complaints.field.future.error'])).toBeTruthy();
    expect(within(dialog).getByText(vi_['lnd.field.tooLong.error'])).toBeTruthy();
    expect(within(dialog).getByText(vi_['lnd.field.required.error'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.complaints.resolveDialog.date.label']), { target: { value: '2026-10-10' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.complaints.resolveDialog.document.label']), { target: { value: ` ${DOCUMENT.toUpperCase()} ` } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.complaints.resolveDialog.note.label']), { target: { value: ' Đã đo lại ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(h.command).toHaveBeenCalledWith(
      'resolveLandComplaint',
      expect.objectContaining({ path: { id: complaintRecord(1).id }, ifMatchVersion: 1, body: { outcome: 'RESOLVED_ACCEPTED', resolved_on: '2026-10-10', note: 'Đã đo lại', resolution_document_version_id: DOCUMENT } }),
    );
  });

  it('escalates without a document, and offers the answer of the higher level for an escalated complaint without offering to escalate it again', async () => {
    const h = client(worldOf(), () => ({ ...OK, status: 'ESCALATED', resource_version: 2 }));
    mount(<ComplaintScreen route={ROUTE} />, h, { permissions: RESOLVER, path: PATH });
    await ready();
    fireEvent.click(resolveButton(rowOf(2), 'LC-000002'));
    let dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('option', { name: vi_['lnd.complaintStatus.escalated.label'] })).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.complaints.resolveDialog.outcome.label']), { target: { value: 'ESCALATED' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.complaints.resolveDialog.note.label']), { target: { value: 'Chuyển lên huyện' } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(h.command).toHaveBeenCalledWith('resolveLandComplaint', expect.objectContaining({ ifMatchVersion: 1, body: { outcome: 'ESCALATED', resolved_on: TODAY, note: 'Chuyển lên huyện' } }));
    fireEvent.click(resolveButton(rowOf(4), 'LC-000004'));
    dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByRole('option', { name: vi_['lnd.complaintStatus.escalated.label'] })).toBeNull();
    expect(within(dialog).getByRole('option', { name: vi_['lnd.complaintStatus.resolvedRejected.label'] })).toBeTruthy();
  });

  it('offers nothing to write to a reader, or to a session that only reads', async () => {
    mount(<ComplaintScreen route={ROUTE} />, client(worldOf()), { permissions: PLAN_READER, path: PATH });
    await ready();
    expect(screen.queryByRole('button', { name: vi_['lnd.complaints.file.action'] })).toBeNull();
    cleanup();
    mount(<ComplaintScreen route={ROUTE} />, client(worldOf()), { permissions: OFFICER, mode: 'READ_ONLY', path: PATH });
    await ready();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    cleanup();
    mount(<ComplaintScreen route={ROUTE} />, client(worldOf()), { permissions: undefined, path: PATH });
    await ready();
    expect(screen.getByRole('button', { name: vi_['lnd.complaints.file.action'] })).toBeTruthy();
    expect(resolveButton(rowOf(1), 'LC-000001')).toBeTruthy();
  });

  it('says why the server refused each command', async () => {
    const cases: Array<[string, number, string]> = [
      ['HOUSEHOLD_NOT_FOUND', 422, 'lnd.complaints.problem.householdNotFound.error'],
      ['COMPLAINT_STATE_INVALID', 409, 'lnd.complaints.problem.stateInvalid.error'],
      ['DECISION_DOCUMENT_REQUIRED', 422, 'lnd.complaints.problem.documentRequired.error'],
      ['DOCUMENT_NOT_CLEAN', 422, 'lnd.complaints.problem.documentNotClean.error'],
      ['TIMER_RULE_UNCONFIRMED', 422, 'lnd.complaints.problem.ruleUnconfirmed.error'],
      ['VERSION_CONFLICT', 409, 'lnd.problem.versionConflict.error'],
      ['SCOPE_DENIED', 403, 'lnd.complaints.problem.scopeDenied.error'],
      ['VALIDATION_FAILED', 422, 'lnd.problem.validation.error'],
      ['RESOURCE_NOT_FOUND', 404, 'lnd.problem.notFound.error'],
    ];
    for (const [code, status, key] of cases) {
      const h = client(worldOf(), () => problem(code, status));
      mount(<ComplaintScreen route={ROUTE} />, h, { permissions: OFFICER, path: PATH });
      await ready();
      fireEvent.click(resolveButton(rowOf(1), 'LC-000001'));
      const dialog = screen.getByRole('dialog');
      fireEvent.change(within(dialog).getByLabelText(vi_['lnd.complaints.resolveDialog.outcome.label']), { target: { value: 'ESCALATED' } });
      fireEvent.change(within(dialog).getByLabelText(vi_['lnd.complaints.resolveDialog.note.label']), { target: { value: 'Chuyển lên huyện' } });
      fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
      expect((await within(dialog).findByTestId('refusal')).textContent).toBe(vi_[key as keyof typeof vi_]);
      cleanup();
    }
    const unknown = client(worldOf(), () => new Error('boom'));
    mount(<ComplaintScreen route={ROUTE} />, unknown, { permissions: OFFICER, path: PATH });
    await ready();
    fireEvent.click(resolveButton(rowOf(1), 'LC-000001'));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.complaints.resolveDialog.outcome.label']), { target: { value: 'ESCALATED' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.complaints.resolveDialog.note.label']), { target: { value: 'Chuyển lên huyện' } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    expect((await within(dialog).findByTestId('refusal')).textContent).toBe(vi_['lnd.problem.general.error']);
  });

  it('shows the complaints a failing read could not give as the error of the screen', async () => {
    const failing = worldOf();
    failing.failing.add('listLandComplaints');
    mount(<ComplaintScreen route={ROUTE} />, client(failing), { permissions: PLAN_READER, path: PATH });
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByTestId('complaints')).toBeNull();
  });
});
