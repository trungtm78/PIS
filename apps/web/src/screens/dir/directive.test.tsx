import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import DirectiveDetailScreen from './DirectiveDetailScreen';
import { AS_OF, MEMBER_A, POLICY, UNIT_A, UNIT_B, directive, harness, mount, overdueDirective, page, refusal, routeOf, text, uuid } from './test-support';
import type { Harness } from './test-support';

afterEach(() => cleanup());

const ROUTE = routeOf('DIR-04');
const DIRECTIVE_ID = uuid(201);
const EXTENSION_ID = uuid(401);
const PATH = `/dir/dir-04?directive=${DIRECTIVE_ID}`;
const EVIDENCE = uuid(501);
const NONE = { assign: false, record_progress: false, request_extension: false, decide_extension: false, close: false, cancel: false, reopen: false };
const ALL = { assign: true, record_progress: true, request_extension: true, decide_extension: false, close: true, cancel: true, reopen: false };
const person = (n: number, name: string) => ({ membership_id: uuid(n), display_name: name });

function detail(options: { line?: Record<string, unknown>; actions?: Partial<typeof ALL>; policy?: Record<string, unknown>; extensions?: unknown[]; evidence?: unknown[]; timeline?: unknown[] } = {}) {
  return {
    directive: directive(1, { id: DIRECTIVE_ID, version: 4, ...options.line }),
    timeline: options.timeline ?? [
      { id: uuid(601), type: 'CREATED', actor: person(122, 'Trần Thị B'), occurred_at: '2026-10-01T02:00:00.000Z', note: null, progress_pct: null, from_assignee_unit: null, to_assignee_unit: { id: UNIT_A, code: 'BQL1', name: 'Ban quản lý 1' }, from_due_on: null, to_due_on: '2026-11-20', extension_id: null, approver: null },
      { id: uuid(602), type: 'PROGRESS', actor: person(121, 'Nguyễn Văn A'), occurred_at: '2026-10-05T02:00:00.000Z', note: 'Đã gửi hồ sơ cho sở.', progress_pct: 30, from_assignee_unit: null, to_assignee_unit: null, from_due_on: null, to_due_on: null, extension_id: null, approver: null },
    ],
    extensions: options.extensions ?? [],
    evidence: options.evidence ?? [],
    policy: { ...POLICY, ...options.policy },
    actions: { ...ALL, ...options.actions },
    as_of: AS_OF,
  };
}

const pendingExtension = { id: EXTENSION_ID, from_due_on: '2026-11-20', proposed_due_on: '2026-12-10', reason: 'Chờ quyết định của UBND tỉnh.', status: 'REQUESTED', requested_by: person(121, 'Nguyễn Văn A'), requested_at: '2026-11-05T02:00:00.000Z', decided_by: null, decided_at: null, decision_reason: null, version: 2 };
const withPending = () => detail({ line: { open_extension: { id: EXTENSION_ID, proposed_due_on: '2026-12-10', requested_by: uuid(121), version: 2 } }, actions: { decide_extension: true, request_extension: false, close: false, cancel: false }, extensions: [pendingExtension] });

const open = (name: string): void => void fireEvent.click(screen.getByRole('button', { name }));
const dialog = (): HTMLElement => screen.getByRole('dialog');
const reasonField = (): HTMLElement => within(dialog()).getByRole('textbox');
const confirm = (name: string): void => {
  fireEvent.click(within(dialog()).getByRole('button', { name }));
};
const type = (label: string, value: string): void => void fireEvent.change(screen.getByLabelText(label), { target: { value } });
const lastCommand = (h: Harness): [string, Record<string, unknown>] => h.command.mock.calls[h.command.mock.calls.length - 1] as [string, Record<string, unknown>];
const mountDetail = (h: Harness, options: { mode?: 'FULL' | 'READ_ONLY'; path?: string } = {}) => mount(<DirectiveDetailScreen route={ROUTE} />, h, { permissions: ['directive.read'], path: options.path ?? PATH, ...(options.mode === undefined ? {} : { mode: options.mode }) });

describe('DIR-04: one directive', () => {
  it('shows what it is, where it stands on its clock, who recorded it, the timeline, the extensions and the evidence, and says the policy is not confirmed', async () => {
    const h = harness(() => detail({ line: { ...overdueDirective(1), id: DIRECTIVE_ID, version: 4, evidence_count: 1, extension_count: 1 }, evidence: [{ id: uuid(701), document_version_id: EVIDENCE, title: 'Biên bản bàn giao', added_by: person(121, 'Nguyễn Văn A'), added_at: '2026-10-06T02:00:00.000Z' }], extensions: [{ ...pendingExtension, status: 'APPROVED', decided_by: person(123, 'Lê C'), decided_at: '2026-11-06T02:00:00.000Z', decision_reason: 'Hợp lý.' }] }));
    mountDetail(h);
    expect(await screen.findByRole('heading', { level: 1, name: 'GB-2026-001/CD-01' })).toBeTruthy();
    expect(screen.getByTestId('directive-text').textContent).toContain('Hoàn thành thủ tục giải phóng mặt bằng');
    const head = document.querySelector('.heading') as HTMLElement;
    expect(within(head).getByText(text('dir.status.overdue.label'))).toBeTruthy();
    expect(within(head).getByText(text('dir.clock.late.text', { days: 5 }))).toBeTruthy();
    expect(screen.getByText(text('dir.directive.extensions.text', { count: 1, max: 3 }))).toBeTruthy();
    expect(screen.getByRole('link', { name: 'GB-2026-001 · Giao ban tuần 40' }).getAttribute('href')).toBe(`/dir/dir-02?meeting=${uuid(301)}`);
    const timeline = screen.getByRole('list', { name: text('dir.timeline.title') });
    const items = within(timeline).getAllByRole('listitem');
    expect(items.map((item) => item.getAttribute('data-event'))).toEqual(['CREATED', 'PROGRESS']);
    expect(within(items[1] as HTMLElement).getByText('Đã gửi hồ sơ cho sở.')).toBeTruthy();
    expect(within(items[1] as HTMLElement).getByText(text('dir.event.pct.text', { pct: 30 }))).toBeTruthy();
    expect(within(items[0] as HTMLElement).getByText(text('dir.event.to.text', { unit: 'BQL1' }))).toBeTruthy();
    expect(screen.getByText(text('dir.extension.status.approved'))).toBeTruthy();
    expect(screen.getByText('Biên bản bàn giao')).toBeTruthy();
    expect(screen.getByText(EVIDENCE)).toBeTruthy();
    expect(screen.getByTestId('policy-note').textContent).toContain(text('dir.policy.unverified.text'));
    expect(h.read).toHaveBeenCalledWith('getDirective', { path: { id: DIRECTIVE_ID } });
  });

  it('opened without a directive it shows the one overdue the longest, says so, and reads the open ones only when none is overdue', async () => {
    const worst = { ...overdueDirective(3), id: DIRECTIVE_ID, code: 'GB-2026-001/CD-03', overdue_days: 12 };
    const reads: Array<Record<string, unknown>> = [];
    const h = harness((operation, input) => {
      if (operation === 'listDirectives') {
        const query = (input as { query: Record<string, unknown> }).query;
        reads.push(query);
        return query.overdue === true ? page([{ ...overdueDirective(1), overdue_days: 2 }, worst]) : page([]);
      }
      if (operation === 'getDirective') return detail({ line: worst });
      return {};
    });
    mountDetail(h, { path: '/dir/dir-04' });
    expect(await screen.findByRole('heading', { level: 1, name: 'GB-2026-001/CD-03' })).toBeTruthy();
    expect(screen.getByTestId('default-target').textContent).toBe(text('dir.directive.default.text'));
    expect(screen.queryByTestId('no-target')).toBeNull();
    expect(h.read).toHaveBeenCalledWith('getDirective', { path: { id: DIRECTIVE_ID } });
    expect(reads.every((query) => query.overdue === true)).toBe(true);
    cleanup();
    const soon = { ...directive(2), id: DIRECTIVE_ID, due_on: '2026-11-12' };
    const later = { ...directive(1), id: uuid(299), due_on: '2026-12-30' };
    const quiet = harness((operation, input) => {
      if (operation === 'listDirectives') return (input as { query: Record<string, unknown> }).query.overdue === true ? page([]) : page([later, { ...directive(4), id: uuid(298), status: 'DONE', due_on: '2026-10-01' }, soon]);
      if (operation === 'getDirective') return detail({ line: soon });
      return {};
    });
    mountDetail(quiet, { path: '/dir/dir-04' });
    await screen.findByTestId('default-target');
    expect(quiet.read).toHaveBeenCalledWith('getDirective', { path: { id: DIRECTIVE_ID } });
    cleanup();
    const named = harness((operation) => (operation === 'getDirective' ? detail() : page([])));
    mountDetail(named);
    await screen.findByRole('heading', { level: 1, name: 'GB-2026-001/CD-01' });
    expect(screen.queryByTestId('default-target')).toBeNull();
    expect(named.read.mock.calls.some((call) => call[0] === 'listDirectives')).toBe(false);
  });

  it('says what to open it from, that it is not there for the caller, and an error, a denial and a skeleton are not "nothing"', async () => {
    mount(<DirectiveDetailScreen route={ROUTE} />, harness((operation) => (operation === 'listDirectives' ? page([]) : {})), { permissions: ['directive.read'], path: '/dir/dir-04' });
    expect((await screen.findByTestId('no-target')).textContent).toBe(text('dir.directive.noTarget.text'));
    cleanup();
    mountDetail(harness(() => refusal('RESOURCE_NOT_FOUND', 404)));
    expect((await screen.findByTestId('missing')).textContent).toBe(text('dir.directive.missing.text'));
    cleanup();
    mountDetail(harness(() => new Error('boom')));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByTestId('missing')).toBeNull();
    cleanup();
    mountDetail(harness(() => refusal('SCOPE_DENIED', 403)));
    expect(await screen.findByText(text('states.denied.title'))).toBeTruthy();
    cleanup();
    mountDetail(harness(() => detail()));
    expect(screen.getByRole('status', { name: text('states.loading.label') })).toBeTruthy();
  });

  it('shows the buttons the server offered, in the state the directive is in, and none to a read-only session', async () => {
    mountDetail(harness(() => detail({ actions: { assign: false, cancel: false, close: false } })));
    await screen.findByRole('heading', { level: 1, name: 'GB-2026-001/CD-01' });
    expect(screen.getByRole('button', { name: text('dir.action.progress.action') })).toBeTruthy();
    expect(screen.getByRole('button', { name: text('dir.action.extension.action') })).toBeTruthy();
    for (const label of ['dir.action.assign.action', 'dir.action.cancel.action', 'dir.action.close.action', 'dir.action.reopen.action', 'dir.action.approve.action', 'dir.action.reject.action']) expect(screen.queryByRole('button', { name: text(label) })).toBeNull();
    cleanup();
    mountDetail(harness(() => detail({ actions: ALL })), { mode: 'READ_ONLY' });
    await screen.findByRole('heading', { level: 1, name: 'GB-2026-001/CD-01' });
    expect(screen.queryByRole('group', { name: text('dir.action.group.label') })).toBeNull();
    cleanup();
    mountDetail(harness(() => detail({ actions: NONE })));
    await screen.findByRole('heading', { level: 1, name: 'GB-2026-001/CD-01' });
    expect(screen.queryByRole('group', { name: text('dir.action.group.label') })).toBeNull();
  });

  it('records progress: checks the percent and the documents, names the directive and the effect in the dialog, wants a note, and sends it without an If-Match', async () => {
    const h = harness(() => detail());
    mountDetail(h);
    await screen.findByRole('heading', { level: 1, name: 'GB-2026-001/CD-01' });
    open(text('dir.action.progress.action'));
    type(text('dir.form.pct.label'), '150');
    fireEvent.click(screen.getByRole('button', { name: text('dir.form.review.action') }));
    expect(screen.getByText(text('dir.form.pct.error'))).toBeTruthy();
    type(text('dir.form.pct.label'), '40');
    type(text('dir.form.documents.label'), 'không phải mã');
    fireEvent.click(screen.getByRole('button', { name: text('dir.form.review.action') }));
    expect(screen.getByText(text('dir.form.documents.error'))).toBeTruthy();
    type(text('dir.form.documents.label'), `${EVIDENCE.toUpperCase()}, ${EVIDENCE}`);
    fireEvent.click(screen.getByRole('button', { name: text('dir.form.review.action') }));

    const box = within(dialog());
    expect(box.getByRole('heading', { name: text('dir.confirm.progress.title') })).toBeTruthy();
    expect(box.getByText('GB-2026-001/CD-01 · Hoàn thành thủ tục giải phóng mặt bằng đợt 1.')).toBeTruthy();
    expect(box.getByText(text('dir.confirm.progress.effectOpen'))).toBeTruthy();
    expect((box.getByRole('button', { name: text('dir.confirm.progress.action') }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(reasonField(), { target: { value: '  Đã gửi hồ sơ lên sở.  ' } });
    confirm(text('dir.confirm.progress.action'));

    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    const [operation, request] = lastCommand(h);
    expect(operation).toBe('recordDirectiveProgress');
    expect(request).toMatchObject({ path: { id: DIRECTIVE_ID }, body: { note: 'Đã gửi hồ sơ lên sở.', progress_pct: 40, evidence_document_version_ids: [EVIDENCE] } });
    expect(request.attempt).toBeDefined();
    expect(request.ifMatchVersion).toBeUndefined();
    expect((await screen.findByTestId('message')).textContent).toBe(text('dir.done.text'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('asks for more time: refuses a day that is not after the due day, too far, or one extension too many, then sends the proposed day with the reason', async () => {
    const h = harness(() => detail());
    mountDetail(h);
    await screen.findByRole('heading', { level: 1, name: 'GB-2026-001/CD-01' });
    open(text('dir.action.extension.action'));
    const review = (): void => void fireEvent.click(screen.getByRole('button', { name: text('dir.form.review.action') }));
    review();
    expect(screen.getByText(text('dir.form.day.error'))).toBeTruthy();
    type(text('dir.form.proposed.label'), '2026-11-20');
    review();
    expect(screen.getByText(text('dir.extension.order.error', { day: '20/11/2026' }))).toBeTruthy();
    type(text('dir.form.proposed.label'), '2027-03-01');
    review();
    expect(screen.getByText(text('dir.extension.days.error', { days: 60 }))).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    type(text('dir.form.proposed.label'), '2026-12-15');
    review();
    const box = within(dialog());
    expect(box.getByText('15/12/2026')).toBeTruthy();
    expect(box.getByText(text('dir.confirm.extension.rule', { count: 3, days: 60 }))).toBeTruthy();
    fireEvent.change(reasonField(), { target: { value: 'Chờ quyết định của UBND tỉnh.' } });
    confirm(text('dir.confirm.extension.action'));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(lastCommand(h)).toMatchObject(['requestDirectiveExtension', { path: { id: DIRECTIVE_ID }, body: { proposed_due_on: '2026-12-15', reason: 'Chờ quyết định của UBND tỉnh.' } }]);
    cleanup();

    const used = harness(() => detail({ line: { extension_count: 3 } }));
    mountDetail(used);
    await screen.findByRole('heading', { level: 1, name: 'GB-2026-001/CD-01' });
    open(text('dir.action.extension.action'));
    type(text('dir.form.proposed.label'), '2026-12-15');
    fireEvent.click(screen.getByRole('button', { name: text('dir.form.review.action') }));
    expect(screen.getByText(text('dir.extension.limit.error', { count: 3 }))).toBeTruthy();
    expect(used.command).not.toHaveBeenCalled();
  });

  it('decides a request for time: shows who asked and why, says the decider must differ, and sends the version of the request in the If-Match against the request', async () => {
    const h = harness(() => withPending());
    mountDetail(h);
    expect((await screen.findByTestId('pending-extension')).textContent).toBe(text('dir.extension.pending.text', { day: '10/12/2026', who: 'Nguyễn Văn A', reason: 'Chờ quyết định của UBND tỉnh.' }));
    expect(screen.queryByRole('button', { name: text('dir.action.close.action') })).toBeNull();
    open(text('dir.action.approve.action'));
    const box = within(dialog());
    expect(box.getByRole('heading', { name: text('dir.confirm.approve.title') })).toBeTruthy();
    expect(box.getByText(text('dir.confirm.decide.rule'))).toBeTruthy();
    expect(box.getByText(text('dir.confirm.approve.effect'))).toBeTruthy();
    expect(box.getByText('10/12/2026')).toBeTruthy();
    fireEvent.change(reasonField(), { target: { value: 'Đồng ý.' } });
    confirm(text('dir.confirm.approve.action'));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(lastCommand(h)).toMatchObject(['decideDirectiveExtension', { path: { id: EXTENSION_ID }, ifMatchVersion: 2, body: { decision: 'approve', reason: 'Đồng ý.' } }]);
    expect((await screen.findByTestId('message')).textContent).toBe(text('dir.done.text'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    open(text('dir.action.reject.action'));
    expect(within(dialog()).getByText(text('dir.confirm.reject.effect'))).toBeTruthy();
    fireEvent.change(reasonField(), { target: { value: 'Đủ thời gian.' } });
    confirm(text('dir.confirm.reject.action'));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
    expect(lastCommand(h)).toMatchObject(['decideDirectiveExtension', { body: { decision: 'reject', reason: 'Đủ thời gian.' } }]);
  });

  it('says in words that the decider must differ when the server refuses the person who asked, and closes the dialog', async () => {
    const h = harness(() => withPending(), () => refusal('SELF_APPROVAL_DENIED', 403));
    mountDetail(h);
    await screen.findByTestId('pending-extension');
    open(text('dir.action.approve.action'));
    fireEvent.change(reasonField(), { target: { value: 'Tôi đồng ý.' } });
    confirm(text('dir.confirm.approve.action'));
    expect((await screen.findByTestId('message')).textContent).toBe(text('dir.error.selfApproval.text'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes a directive: wants evidence when the policy does, names the recorder and the assignee as the two who cannot close, and sends the notes and documents with the version', async () => {
    const h = harness(() => detail());
    mountDetail(h);
    await screen.findByRole('heading', { level: 1, name: 'GB-2026-001/CD-01' });
    open(text('dir.action.close.action'));
    expect(screen.getByText(text('dir.form.documents.required', { count: 0 }))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: text('dir.form.review.action') }));
    expect(screen.getByText(text('dir.error.evidenceRequired.text'))).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    type(text('dir.form.documents.label'), EVIDENCE);
    fireEvent.click(screen.getByRole('button', { name: text('dir.form.review.action') }));
    const box = within(dialog());
    expect(box.getByText(text('dir.confirm.close.rule', { creator: 'Trần Thị B', assignee: 'Nguyễn Văn A' }))).toBeTruthy();
    expect(box.getByText(text('dir.confirm.close.effect'))).toBeTruthy();
    fireEvent.change(reasonField(), { target: { value: 'Đã bàn giao mặt bằng.' } });
    confirm(text('dir.confirm.close.action'));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(lastCommand(h)).toMatchObject(['closeDirective', { path: { id: DIRECTIVE_ID }, ifMatchVersion: 4, body: { note: 'Đã bàn giao mặt bằng.', evidence_document_version_ids: [EVIDENCE] } }]);
  });

  it('closes without a new document when the directive already has one, or when the policy does not ask for evidence', async () => {
    const h = harness(() => detail({ line: { evidence_count: 1 } }));
    mountDetail(h);
    await screen.findByRole('heading', { level: 1, name: 'GB-2026-001/CD-01' });
    open(text('dir.action.close.action'));
    fireEvent.click(screen.getByRole('button', { name: text('dir.form.review.action') }));
    fireEvent.change(reasonField(), { target: { value: 'Xong.' } });
    confirm(text('dir.confirm.close.action'));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect((lastCommand(h)[1] as { body: Record<string, unknown> }).body).toEqual({ note: 'Xong.' });
    cleanup();
    const relaxed = harness(() => detail({ policy: { close_requires_evidence: false } }));
    mountDetail(relaxed);
    await screen.findByRole('heading', { level: 1, name: 'GB-2026-001/CD-01' });
    open(text('dir.action.close.action'));
    fireEvent.click(screen.getByRole('button', { name: text('dir.form.review.action') }));
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('says in words why a close was refused, and reads the directive again when it changed meanwhile', async () => {
    const h = harness(() => detail({ line: { evidence_count: 1 } }), () => refusal('VERSION_CONFLICT', 409));
    mountDetail(h);
    await screen.findByRole('heading', { level: 1, name: 'GB-2026-001/CD-01' });
    const before = h.read.mock.calls.filter(([operation]) => operation === 'getDirective').length;
    open(text('dir.action.close.action'));
    fireEvent.click(screen.getByRole('button', { name: text('dir.form.review.action') }));
    fireEvent.change(reasonField(), { target: { value: 'Xong.' } });
    confirm(text('dir.confirm.close.action'));
    expect((await screen.findByTestId('message')).textContent).toBe(text('dir.error.versionConflict.text'));
    await waitFor(() => expect(h.read.mock.calls.filter(([operation]) => operation === 'getDirective').length).toBeGreaterThan(before));
  });

  it('cancels and reopens with a reason and the version, straight from a dialog that says what follows', async () => {
    const h = harness(() => detail());
    mountDetail(h);
    await screen.findByRole('heading', { level: 1, name: 'GB-2026-001/CD-01' });
    open(text('dir.action.cancel.action'));
    expect(within(dialog()).getByText(text('dir.confirm.cancel.effect'))).toBeTruthy();
    fireEvent.change(reasonField(), { target: { value: 'Dự án đã dừng.' } });
    confirm(text('dir.confirm.cancel.action'));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(lastCommand(h)).toMatchObject(['cancelDirective', { path: { id: DIRECTIVE_ID }, ifMatchVersion: 4, body: { reason: 'Dự án đã dừng.' } }]);
    cleanup();

    const done = harness(() => detail({ line: { status: 'DONE', stored_status: 'DONE', phase: 'ENDED' }, actions: { assign: false, record_progress: false, request_extension: false, close: false, cancel: false, reopen: true } }));
    mountDetail(done);
    await screen.findByRole('heading', { level: 1, name: 'GB-2026-001/CD-01' });
    expect(screen.queryByRole('button', { name: text('dir.action.close.action') })).toBeNull();
    open(text('dir.action.reopen.action'));
    expect(within(dialog()).getByText(text('dir.confirm.reopen.effectDone'))).toBeTruthy();
    fireEvent.change(reasonField(), { target: { value: 'Chưa đạt yêu cầu.' } });
    confirm(text('dir.confirm.reopen.action'));
    await waitFor(() => expect(done.command).toHaveBeenCalledTimes(1));
    expect(lastCommand(done)).toMatchObject(['reopenDirective', { ifMatchVersion: 4, body: { reason: 'Chưa đạt yêu cầu.' } }]);
  });

  it('Escape leaves the dialog without sending anything', async () => {
    const h = harness(() => detail());
    mountDetail(h);
    await screen.findByRole('heading', { level: 1, name: 'GB-2026-001/CD-01' });
    open(text('dir.action.cancel.action'));
    fireEvent.keyDown(dialog(), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('gives the directive to another unit and person, or takes the person off, sending only what changed', async () => {
    const h = harness(() => detail());
    mountDetail(h);
    await screen.findByRole('heading', { level: 1, name: 'GB-2026-001/CD-01' });
    open(text('dir.action.assign.action'));
    await waitFor(() => expect(within(screen.getByRole('form', { name: text('dir.confirm.assign.title') })).getAllByRole('option', { name: 'SXD · Sở Xây dựng' }).length).toBe(1));
    fireEvent.click(screen.getByRole('button', { name: text('dir.form.review.action') }));
    expect(screen.getByText(text('dir.assign.nothing.error'))).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    type(text('dir.assign.unit.label'), UNIT_B);
    type(text('dir.assign.member.label'), MEMBER_A);
    fireEvent.click(screen.getByRole('button', { name: text('dir.form.review.action') }));
    // The note is not required.
    expect((within(dialog()).getByRole('button', { name: text('dir.confirm.assign.action') }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(reasonField(), { target: { value: 'Giao đơn vị pháp lý.' } });
    confirm(text('dir.confirm.assign.action'));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(lastCommand(h)).toMatchObject(['assignDirective', { path: { id: DIRECTIVE_ID }, ifMatchVersion: 4, body: { assignee_unit_id: UNIT_B, assignee_membership_id: MEMBER_A, note: 'Giao đơn vị pháp lý.' } }]);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    open(text('dir.action.assign.action'));
    type(text('dir.assign.member.label'), 'none');
    fireEvent.click(screen.getByRole('button', { name: text('dir.form.review.action') }));
    confirm(text('dir.confirm.assign.action'));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
    expect((lastCommand(h)[1] as { body: Record<string, unknown> }).body).toEqual({ assignee_membership_id: null });
  });
});
