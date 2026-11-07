import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import MeetingDetailScreen from './MeetingDetailScreen';
import MeetingListScreen from './MeetingListScreen';
import { AS_OF, MEMBER_A, POLICY, PROJECT_A, UNIT_A, UNIT_B, directive, harness, meeting, mount, overdueDirective, page, refusal, routeOf, text, uuid } from './test-support';

afterEach(() => cleanup());

const MEETING_ID = uuid(301);
const LIST = routeOf('DIR-01');
const DETAIL = routeOf('DIR-02');
const ALL = ['directive.meeting.manage', 'directive.manage', 'directive.read'];
const input = (label: string): HTMLElement => screen.getByLabelText(label);
const type = (label: string, value: string): void => void fireEvent.change(input(label), { target: { value } });
/** Waits until a lookup of the form is loaded: its option is there (the filter above has the same units, so the form is asked, not the page). */
const optionIn = (form: string, name: string) => waitFor(() => expect(within(screen.getByRole('form', { name: text(form) })).getAllByRole('option', { name }).length).toBeGreaterThan(0));

describe('DIR-01: the steering meetings', () => {
  it('shows the meetings the latest first with the directives each gave by status, the late ones marked, and the time the page was read', async () => {
    const h = harness(() => page([meeting(1, { minutes_document_version_id: uuid(9) }), meeting(2, { counts: { total: 2, by_status: { OPEN: 2 } } })]));
    mount(<MeetingListScreen route={LIST} />, h, { permissions: ALL });
    expect(await screen.findByRole('link', { name: 'GB-2026-001' })).toBeTruthy();
    const row = screen.getByRole('link', { name: 'GB-2026-001' }).closest('tr') as HTMLElement;
    expect(within(row).getByText(text('dir.meetings.minutes.attached'))).toBeTruthy();
    expect(within(row).getByText('01/10/2026')).toBeTruthy();
    expect(within(row).getByText(text('dir.type.weekly.label'))).toBeTruthy();
    expect(within(row).getAllByText('4').length).toBeGreaterThan(0);
    expect(within(row).getByText('1', { selector: '.ui-pill span' })).toBeTruthy();
    const second = screen.getByRole('link', { name: 'GB-2026-002' }).closest('tr') as HTMLElement;
    expect(within(second).getByText(text('dir.meetings.minutes.missing'))).toBeTruthy();
    expect(screen.getByRole('link', { name: 'GB-2026-001' }).getAttribute('href')).toBe(`/dir/dir-02?meeting=${uuid(301)}`);
    expect(document.querySelector('.ui-context__asof')?.textContent).toContain('08/11/2026');
    expect(h.read).toHaveBeenCalledWith('listSteeringMeetings', { query: { limit: 20 } });
  });

  it('shows a skeleton while it reads, never a table of zeros', () => {
    mount(<MeetingListScreen route={LIST} />, harness(() => page([])), { permissions: ALL });
    expect(screen.getByRole('status', { name: text('states.loading.label') })).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('says there is nothing, says the filter is why when one is set, and clears it', async () => {
    const h = harness(() => page([]));
    mount(<MeetingListScreen route={LIST} />, h, { permissions: ALL });
    expect(await screen.findByText(text('ui.dataTable.emptyNone'))).toBeTruthy();
    fireEvent.change(input(text('dir.filter.type.label')), { target: { value: 'MONTHLY' } });
    expect(await screen.findByText(text('ui.dataTable.emptyFiltered'))).toBeTruthy();
    await waitFor(() => expect(h.read).toHaveBeenLastCalledWith('listSteeringMeetings', { query: { limit: 20, meeting_type: 'MONTHLY' } }));
    fireEvent.click(screen.getAllByRole('button', { name: text('dir.filter.clear.action') })[0] as HTMLElement);
    expect(await screen.findByText(text('ui.dataTable.emptyNone'))).toBeTruthy();
  });

  it('a failing read is an error with a retry, a refusal is "denied", and neither is an empty list', async () => {
    const failing = harness(() => new Error('boom'));
    mount(<MeetingListScreen route={LIST} />, failing, { permissions: ALL });
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText(text('ui.dataTable.emptyNone'))).toBeNull();
    const before = failing.read.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: text('states.retry.action') }));
    await waitFor(() => expect(failing.read.mock.calls.length).toBeGreaterThan(before));
    cleanup();
    mount(<MeetingListScreen route={LIST} />, harness(() => refusal('SCOPE_DENIED', 403)), { permissions: ALL });
    expect(await screen.findByText(text('states.denied.title'))).toBeTruthy();
  });

  it('keeps what it showed and says it is stale when a refresh fails', async () => {
    let fail = false;
    const h = harness(() => (fail ? new Error('boom') : page([meeting(1)])));
    const { queries } = mount(<MeetingListScreen route={LIST} />, h, { permissions: ALL });
    expect(await screen.findByRole('link', { name: 'GB-2026-001' })).toBeTruthy();
    fail = true;
    await queries.invalidateQueries();
    await waitFor(() => expect(document.querySelector('.ui-context .ui-pill')).not.toBeNull());
    expect(screen.getByRole('link', { name: 'GB-2026-001' })).toBeTruthy();
  });

  it('pages by the cursor of the server, back and forth', async () => {
    const h = harness((_operation, request) => {
      const cursor = (request as { query: { cursor?: string } }).query.cursor;
      return cursor === undefined ? page([meeting(1)], 'c2') : page([meeting(2)]);
    });
    mount(<MeetingListScreen route={LIST} />, h, { permissions: ALL });
    expect(await screen.findByRole('link', { name: 'GB-2026-001' })).toBeTruthy();
    const next = screen.getByRole('button', { name: text('dir.pager.next.action') }) as HTMLButtonElement;
    const previous = screen.getByRole('button', { name: text('dir.pager.previous.action') }) as HTMLButtonElement;
    expect(previous.disabled).toBe(true);
    fireEvent.click(next);
    expect(await screen.findByRole('link', { name: 'GB-2026-002' })).toBeTruthy();
    expect(h.read).toHaveBeenLastCalledWith('listSteeringMeetings', { query: { limit: 20, cursor: 'c2' } });
    expect((screen.getByRole('button', { name: text('dir.pager.next.action') }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: text('dir.pager.previous.action') }));
    expect(await screen.findByRole('link', { name: 'GB-2026-001' })).toBeTruthy();
  });

  it('records a meeting: asks for what is missing, then sends the day, type, unit and title with an idempotency attempt, and says the code', async () => {
    const h = harness(() => page([]), () => ({ resource_id: uuid(1), code: 'GB-2026-007' }));
    mount(<MeetingListScreen route={LIST} />, h, { permissions: ALL });
    fireEvent.click(await screen.findByRole('button', { name: text('dir.meetings.create.action') }));
    fireEvent.click(screen.getByRole('button', { name: text('dir.meetings.create.submit.action') }));
    expect(screen.getAllByText(text('dir.form.required.error')).length).toBe(2);
    expect(screen.getByText(text('dir.meetings.create.date.error'))).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();

    type(text('dir.meetings.create.date.label'), '2999-01-01');
    fireEvent.click(screen.getByRole('button', { name: text('dir.meetings.create.submit.action') }));
    expect(screen.getByText(text('dir.meetings.create.future.error'))).toBeTruthy();

    type(text('dir.meetings.create.date.label'), '2026-11-03');
    type(text('dir.meetings.create.type.label'), 'MONTHLY');
    type(text('dir.meetings.create.name.label'), '  Giao ban tháng 11  ');
    await optionIn('dir.meetings.create.title', 'BQL1 · Ban quản lý 1');
    type(text('dir.meetings.create.unit.label'), UNIT_A);
    type(text('dir.meetings.create.minutes.label'), 'không phải mã');
    fireEvent.click(screen.getByRole('button', { name: text('dir.meetings.create.submit.action') }));
    expect(screen.getByText(text('dir.form.document.error'))).toBeTruthy();
    type(text('dir.meetings.create.minutes.label'), uuid(9).toUpperCase());
    fireEvent.click(screen.getByRole('button', { name: text('dir.meetings.create.submit.action') }));

    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    const [operation, request] = h.command.mock.calls[0] as [string, { body: Record<string, unknown>; attempt: unknown; path?: unknown }];
    expect(operation).toBe('createSteeringMeeting');
    expect(request.body).toEqual({ meeting_date: '2026-11-03', meeting_type: 'MONTHLY', title: 'Giao ban tháng 11', unit_id: UNIT_A, minutes_document_version_id: uuid(9) });
    expect(request.attempt).toBeDefined();
    expect(request.path).toBeUndefined();
    expect((await screen.findByTestId('message')).textContent).toBe(text('dir.meetings.create.done.text', { code: 'GB-2026-007' }));
    expect(screen.queryByRole('form', { name: text('dir.meetings.create.title') })).toBeNull();
  });

  it('says in words why a record was refused and keeps the form', async () => {
    const h = harness(() => page([]), () => refusal('SCOPE_DENIED', 403));
    mount(<MeetingListScreen route={LIST} />, h, { permissions: ALL });
    fireEvent.click(await screen.findByRole('button', { name: text('dir.meetings.create.action') }));
    type(text('dir.meetings.create.date.label'), '2026-11-03');
    type(text('dir.meetings.create.name.label'), 'Giao ban');
    await optionIn('dir.meetings.create.title', 'SXD · Sở Xây dựng');
    type(text('dir.meetings.create.unit.label'), UNIT_B);
    fireEvent.click(screen.getByRole('button', { name: text('dir.meetings.create.submit.action') }));
    expect((await screen.findByTestId('message')).textContent).toBe(text('dir.error.scope.text'));
    expect(screen.getByRole('form', { name: text('dir.meetings.create.title') })).toBeTruthy();
  });

  it('offers no button to record to a session that may not, nor to a read-only one', async () => {
    mount(<MeetingListScreen route={LIST} />, harness(() => page([meeting(1)])), { permissions: ['directive.read'] });
    expect(await screen.findByRole('link', { name: 'GB-2026-001' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: text('dir.meetings.create.action') })).toBeNull();
    cleanup();
    mount(<MeetingListScreen route={LIST} />, harness(() => page([meeting(1)])), { permissions: ALL, mode: 'READ_ONLY' });
    expect(await screen.findByRole('link', { name: 'GB-2026-001' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: text('dir.meetings.create.action') })).toBeNull();
  });
});

const detailAnswer = (actions = { add_directive: true, attach_minutes: true }, directives: unknown[] = [overdueDirective(1), directive(2), directive(3, { scope_kind: 'UNIT', project: null })]) => ({
  meeting: meeting(1, { id: MEETING_ID, summary: 'Rà soát giải ngân.', minutes_document_version_id: uuid(9) }),
  directives,
  truncated: false,
  actions,
  policy: POLICY,
  as_of: AS_OF,
});

describe('DIR-02: one meeting', () => {
  const path = `/dir/dir-02?meeting=${MEETING_ID}`;

  it('shows the meeting, its minutes, the counts and each directive with its clock and status; the code opens the directive; the policy is said to be unconfirmed', async () => {
    const h = harness(() => detailAnswer());
    mount(<MeetingDetailScreen route={DETAIL} />, h, { permissions: ALL, path });
    expect(await screen.findByRole('heading', { level: 1, name: 'GB-2026-001 · Giao ban tuần 1' })).toBeTruthy();
    expect(screen.getByTestId('minutes').textContent).toBe(text('dir.meeting.minutes.ref', { id: uuid(9) }));
    expect(screen.getByText('Rà soát giải ngân.')).toBeTruthy();
    expect(screen.getByText(text('dir.meeting.counts.text', { total: 4, open: 2, overdue: 1, done: 1 }))).toBeTruthy();
    const late = screen.getByRole('link', { name: 'GB-2026-001/CD-01' }).closest('tr') as HTMLElement;
    expect(within(late).getByText(text('dir.clock.late.text', { days: 5 }))).toBeTruthy();
    expect(within(late).getByText(text('dir.status.overdue.label'))).toBeTruthy();
    expect(screen.getByRole('link', { name: 'GB-2026-001/CD-01' }).getAttribute('href')).toBe(`/dir/dir-04?directive=${uuid(201)}`);
    const unit = screen.getByRole('link', { name: 'GB-2026-001/CD-03' }).closest('tr') as HTMLElement;
    expect(within(unit).getByText(text('dir.table.about.unit', { unit: 'BQL1' }))).toBeTruthy();
    expect(screen.getByTestId('policy-note').textContent).toContain(text('dir.policy.unverified.text'));
    expect(h.read).toHaveBeenCalledWith('getSteeringMeeting', { path: { id: MEETING_ID } });
  });

  it('says what to open it from, that the meeting is not there for the caller, and shows an error or denial rather than an empty list', async () => {
    mount(<MeetingDetailScreen route={DETAIL} />, harness(() => ({})), { permissions: ALL, path: '/dir/dir-02' });
    expect(screen.getByTestId('no-target').textContent).toBe(text('dir.meeting.noTarget.text'));
    cleanup();
    mount(<MeetingDetailScreen route={DETAIL} />, harness(() => refusal('RESOURCE_NOT_FOUND', 404)), { permissions: ALL, path });
    expect((await screen.findByTestId('missing')).textContent).toBe(text('dir.meeting.missing.text'));
    cleanup();
    mount(<MeetingDetailScreen route={DETAIL} />, harness(() => new Error('boom')), { permissions: ALL, path });
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByTestId('missing')).toBeNull();
    cleanup();
    mount(<MeetingDetailScreen route={DETAIL} />, harness(() => refusal('SCOPE_DENIED', 403)), { permissions: ALL, path });
    expect(await screen.findByText(text('states.denied.title'))).toBeTruthy();
  });

  it('shows an empty list of directives as empty', async () => {
    mount(<MeetingDetailScreen route={DETAIL} />, harness(() => detailAnswer(undefined, [])), { permissions: ALL, path });
    expect(await screen.findByText(text('ui.dataTable.emptyNone'))).toBeTruthy();
  });

  it('shows the buttons the server offered and no others, and none to a read-only session', async () => {
    mount(<MeetingDetailScreen route={DETAIL} />, harness(() => detailAnswer({ add_directive: false, attach_minutes: true })), { permissions: ALL, path });
    expect(await screen.findByRole('button', { name: text('dir.meeting.minutes.action') })).toBeTruthy();
    expect(screen.queryByRole('button', { name: text('dir.meeting.add.action') })).toBeNull();
    cleanup();
    mount(<MeetingDetailScreen route={DETAIL} />, harness(() => detailAnswer()), { permissions: ALL, mode: 'READ_ONLY', path });
    expect(await screen.findByRole('heading', { level: 1, name: /GB-2026-001/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: text('dir.meeting.add.action') })).toBeNull();
    expect(screen.queryByRole('button', { name: text('dir.meeting.minutes.action') })).toBeNull();
  });

  it('gives a directive about a project: checks the form, then sends the body with the meeting in the path and an attempt', async () => {
    const h = harness(() => detailAnswer(), () => ({ resource_id: uuid(5), code: 'GB-2026-001/CD-04' }));
    mount(<MeetingDetailScreen route={DETAIL} />, h, { permissions: ALL, path });
    fireEvent.click(await screen.findByRole('button', { name: text('dir.meeting.add.action') }));
    fireEvent.click(screen.getByRole('button', { name: text('dir.meeting.add.submit.action') }));
    expect(screen.getAllByText(text('dir.form.required.error')).length).toBe(3);
    expect(screen.getByText(text('dir.form.day.error'))).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();

    await optionIn('dir.meeting.add.title', 'DA-01 · Đường tỉnh 205');
    type(text('dir.meeting.add.project.label'), PROJECT_A);
    type(text('dir.meeting.add.text.label'), '  Hoàn thành bồi thường trước tháng 12.  ');
    type(text('dir.meeting.add.assigneeUnit.label'), UNIT_B);
    type(text('dir.meeting.add.assignee.label'), MEMBER_A);
    type(text('dir.meeting.add.due.label'), '2026-09-30');
    fireEvent.click(screen.getByRole('button', { name: text('dir.meeting.add.submit.action') }));
    expect(screen.getByText(text('dir.meeting.add.due.error', { day: '01/10/2026' }))).toBeTruthy();
    type(text('dir.meeting.add.due.label'), '2026-12-15');
    fireEvent.click(screen.getByRole('button', { name: text('dir.meeting.add.submit.action') }));

    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    const [operation, request] = h.command.mock.calls[0] as [string, { body: Record<string, unknown>; path: { id: string }; attempt: unknown }];
    expect(operation).toBe('addDirective');
    expect(request.path).toEqual({ id: MEETING_ID });
    expect(request.body).toEqual({ scope_kind: 'PROJECT', project_id: PROJECT_A, text: 'Hoàn thành bồi thường trước tháng 12.', assignee_unit_id: UNIT_B, assignee_membership_id: MEMBER_A, due_on: '2026-12-15' });
    expect(request.attempt).toBeDefined();
    expect((await screen.findByTestId('message')).textContent).toBe(text('dir.meeting.add.done.text'));
  });

  it('gives a directive about a unit: no project is sent, and no person when none is chosen', async () => {
    const h = harness(() => detailAnswer());
    mount(<MeetingDetailScreen route={DETAIL} />, h, { permissions: ALL, path });
    fireEvent.click(await screen.findByRole('button', { name: text('dir.meeting.add.action') }));
    fireEvent.click(screen.getByLabelText(text('dir.meeting.add.kind.unit')));
    expect(screen.queryByLabelText(text('dir.meeting.add.project.label'))).toBeNull();
    await optionIn('dir.meeting.add.title', 'BQL1 · Ban quản lý 1');
    type(text('dir.meeting.add.unit.label'), UNIT_A);
    type(text('dir.meeting.add.text.label'), 'Báo cáo tiến độ hằng tuần.');
    type(text('dir.meeting.add.assigneeUnit.label'), UNIT_A);
    type(text('dir.meeting.add.due.label'), '2026-12-15');
    fireEvent.click(screen.getByRole('button', { name: text('dir.meeting.add.submit.action') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect((h.command.mock.calls[0] as [string, { body: Record<string, unknown> }])[1].body).toEqual({ scope_kind: 'UNIT', unit_id: UNIT_A, text: 'Báo cáo tiến độ hằng tuần.', assignee_unit_id: UNIT_A, due_on: '2026-12-15' });
  });

  it('says why the server refused a directive and keeps the form', async () => {
    const h = harness(() => detailAnswer(), () => refusal('SCOPE_DENIED', 403));
    mount(<MeetingDetailScreen route={DETAIL} />, h, { permissions: ALL, path });
    fireEvent.click(await screen.findByRole('button', { name: text('dir.meeting.add.action') }));
    await optionIn('dir.meeting.add.title', 'DA-01 · Đường tỉnh 205');
    type(text('dir.meeting.add.project.label'), PROJECT_A);
    type(text('dir.meeting.add.text.label'), 'Chỉ đạo.');
    type(text('dir.meeting.add.assigneeUnit.label'), UNIT_A);
    type(text('dir.meeting.add.due.label'), '2026-12-15');
    fireEvent.click(screen.getByRole('button', { name: text('dir.meeting.add.submit.action') }));
    expect((await screen.findByTestId('message')).textContent).toBe(text('dir.error.scope.text'));
    expect(screen.getByRole('form', { name: text('dir.meeting.add.title') })).toBeTruthy();
  });

  it('attaches the minutes with the version of the meeting in the If-Match', async () => {
    const h = harness(() => detailAnswer());
    mount(<MeetingDetailScreen route={DETAIL} />, h, { permissions: ALL, path });
    fireEvent.click(await screen.findByRole('button', { name: text('dir.meeting.minutes.action') }));
    fireEvent.click(screen.getByRole('button', { name: text('dir.meeting.minutes.submit.action') }));
    expect(screen.getByText(text('dir.form.document.error'))).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    type(text('dir.meeting.minutes.field.label'), uuid(77));
    fireEvent.click(screen.getByRole('button', { name: text('dir.meeting.minutes.submit.action') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    const [operation, request] = h.command.mock.calls[0] as [string, { body: unknown; path: { id: string }; ifMatchVersion: number }];
    expect(operation).toBe('attachMeetingMinutes');
    expect(request).toMatchObject({ path: { id: MEETING_ID }, ifMatchVersion: 3, body: { document_version_id: uuid(77) } });
    expect((await screen.findByTestId('message')).textContent).toBe(text('dir.meeting.minutes.done.text'));
  });

  it('says a stale version in words when the minutes were attached by someone else meanwhile', async () => {
    const h = harness(() => detailAnswer(), () => refusal('VERSION_CONFLICT', 409));
    mount(<MeetingDetailScreen route={DETAIL} />, h, { permissions: ALL, path });
    fireEvent.click(await screen.findByRole('button', { name: text('dir.meeting.minutes.action') }));
    type(text('dir.meeting.minutes.field.label'), uuid(77));
    fireEvent.click(screen.getByRole('button', { name: text('dir.meeting.minutes.submit.action') }));
    expect((await screen.findByTestId('message')).textContent).toBe(text('dir.error.versionConflict.text'));
  });
});
