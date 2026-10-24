import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import IssueVerificationScreen from './IssueVerificationScreen';
import { HANDLER, READER, VERIFIER, client, detail, event, member, mountIssue, person, routeOf, unit, world } from './test-support';
import type { World } from './test-support';

const ROUTE = routeOf('ISS-07', 'FR-ISS-07');
const problem = (code: string, status = 409) => new ApiError({ status, code, correlationId: 'c', extensions: {} });
const DONE = { operation_id: 'o', status: 'PENDING_VERIFICATION', resource_version: 5, resource_id: 'x' };
const DOC_A = '00000000-0000-4000-8000-0000000000a1';
const DOC_B = '00000000-0000-4000-8000-0000000000b2';

afterEach(cleanup);

const open = (issue: Record<string, unknown>, permissions: readonly string[] | undefined, overrides: Partial<World> = {}, mode?: 'FULL' | 'READ_ONLY') => {
  const h = client(world({ details: [issue], units: [unit(1)], members: [member(1), member(2)], ...overrides }), () => DONE);
  mountIssue(<IssueVerificationScreen route={ROUTE} />, h, { permissions, path: `/iss/iss-07?id=${String(issue.id)}`, ...(mode === undefined ? {} : { mode }) });
  return h;
};
const ready = () => screen.findByTestId('action-summary');
const waiting = (extra: Record<string, unknown> = {}) =>
  detail(1, {
    status: 'PENDING_VERIFICATION',
    assignee: person(2),
    version: 4,
    events: [
      event(1, 'CREATED'),
      event(2, 'VERIFICATION_REQUESTED', { actor: person(2), note: 'Đã chi trả và bàn giao mặt bằng', payload: { evidence_document_version_ids: [DOC_A, DOC_B] }, from_status: 'IN_PROGRESS', to_status: 'PENDING_VERIFICATION' }),
    ],
    ...extra,
  });

describe('IssueVerificationScreen (ISS-07): the verification and the closing', () => {
  describe('the handler asks for the verification', () => {
    const working = (extra: Record<string, unknown> = {}) => detail(1, { status: 'IN_PROGRESS', assignee: person(1), version: 3, ...extra });

    it('UI-ISS-07: sends the result and the evidence with the version that was read, and tells what happened', async () => {
      const h = open(working(), HANDLER);
      await ready();
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['iss.verification.page.title']);
      expect(screen.queryByRole('button', { name: vi_['iss.verification.close.action'] })).toBeNull();
      fireEvent.change(screen.getByLabelText(vi_['iss.verification.request.note.label']), { target: { value: ' Đã bàn giao mặt bằng ' } });
      fireEvent.change(screen.getByLabelText(vi_['iss.verification.request.evidence.label']), { target: { value: `${DOC_A.toUpperCase()}\n${DOC_B}\n${DOC_A}` } });
      fireEvent.click(screen.getByRole('button', { name: vi_['iss.verification.request.action'] }));
      expect((await screen.findByTestId('done')).textContent).toBe(vi_['iss.verification.request.done']);
      expect(h.command).toHaveBeenCalledWith(
        'requestIssueVerification',
        expect.objectContaining({ path: { id: working().id }, body: { result_note: 'Đã bàn giao mặt bằng', evidence_document_version_ids: [DOC_A, DOC_B] }, ifMatchVersion: 3 }),
      );
    });

    it('AC-ST-ISS-003-1: asks for the result and for the evidence the policy requires before it sends anything, and says what is wrong with the documents', async () => {
      const h = open(working(), HANDLER);
      await ready();
      fireEvent.click(screen.getByRole('button', { name: vi_['iss.verification.request.action'] }));
      const alerts = screen.getAllByRole('alert').map((alert) => alert.textContent);
      expect(alerts).toContain(vi_['iss.field.required.error']);
      expect(alerts).toContain(vi_['iss.verification.evidenceRequired.error']);
      fireEvent.change(screen.getByLabelText(vi_['iss.verification.request.note.label']), { target: { value: 'x'.repeat(2001) } });
      fireEvent.change(screen.getByLabelText(vi_['iss.verification.request.evidence.label']), { target: { value: 'not-an-id' } });
      fireEvent.click(screen.getByRole('button', { name: vi_['iss.verification.request.action'] }));
      const again = screen.getAllByRole('alert').map((alert) => alert.textContent);
      expect(again).toContain(vi_['iss.field.tooLong.error']);
      expect(again).toContain(vi_['iss.verification.evidenceInvalid.error']);
      const many = Array.from({ length: 21 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`).join('\n');
      fireEvent.change(screen.getByLabelText(vi_['iss.verification.request.evidence.label']), { target: { value: many } });
      fireEvent.click(screen.getByRole('button', { name: vi_['iss.verification.request.action'] }));
      expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toContain(vi_['iss.verification.evidenceTooMany.error'].replace('{max}', '20'));
      expect(h.command).not.toHaveBeenCalled();
    });

    it('takes no evidence when the policy asks for none, and shows the refusal of the server', async () => {
      const sla = { policy_id: 'p', policy_code: 'SLA', policy_revision: 1, calendar_code: 'WORKDAY_VN', response_hours: 4, resolve_hours: 8, require_evidence: false, require_independent_verifier: true };
      const h = open(working({ sla }), HANDLER);
      h.command.mockRejectedValueOnce(problem('EVIDENCE_REQUIRED', 422)).mockResolvedValue(DONE);
      await ready();
      fireEvent.change(screen.getByLabelText(vi_['iss.verification.request.note.label']), { target: { value: 'Xong' } });
      fireEvent.click(screen.getByRole('button', { name: vi_['iss.verification.request.action'] }));
      await waitFor(() => expect(screen.getByTestId('problem').textContent).toBe(vi_['iss.issueProblem.evidenceRequired.error']));
      expect(h.command).toHaveBeenCalledWith('requestIssueVerification', expect.objectContaining({ body: { result_note: 'Xong', evidence_document_version_ids: [] } }));
    });
  });

  describe('a different person confirms', () => {
    it('AC-ST-ISS-003-1: shows the result and the evidence, and closes the issue with the confirmation and the version that was read', async () => {
      const h = open(waiting(), VERIFIER);
      await ready();
      expect(screen.getByTestId('result-note').textContent).toBe('Đã chi trả và bàn giao mặt bằng');
      expect(within(screen.getByTestId('result-evidence')).getAllByRole('listitem').map((item) => item.textContent)).toEqual([DOC_A, DOC_B]);
      expect(screen.getByTestId('result-by').textContent).toContain('Nguyễn Văn B');
      fireEvent.click(screen.getByRole('button', { name: vi_['iss.verification.close.action'] }));
      expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toContain(vi_['iss.field.required.error']);
      expect(h.command).not.toHaveBeenCalled();
      fireEvent.change(screen.getByLabelText(vi_['iss.verification.close.note.label']), { target: { value: ' Đã kiểm tra hiện trường ' } });
      fireEvent.click(screen.getByRole('button', { name: vi_['iss.verification.close.action'] }));
      expect((await screen.findByTestId('done')).textContent).toBe(vi_['iss.verification.close.done']);
      expect(h.command).toHaveBeenCalledWith('closeIssue', expect.objectContaining({ path: { id: waiting().id }, body: { verification_note: 'Đã kiểm tra hiện trường' }, ifMatchVersion: 4 }));
    });

    it('AC-ST-ISS-003-1: says why the server refused the closing, and offers to read the issue again after a conflict', async () => {
      const h = open(waiting(), VERIFIER);
      h.command.mockRejectedValueOnce(problem('SELF_APPROVAL_DENIED', 403)).mockRejectedValueOnce(problem('VERSION_CONFLICT'));
      await ready();
      fireEvent.change(screen.getByLabelText(vi_['iss.verification.close.note.label']), { target: { value: 'Đã kiểm tra' } });
      fireEvent.click(screen.getByRole('button', { name: vi_['iss.verification.close.action'] }));
      await waitFor(() => expect(screen.getByTestId('problem').textContent).toBe(vi_['iss.issueProblem.selfApproval.error']));
      fireEvent.click(screen.getByRole('button', { name: vi_['iss.verification.close.action'] }));
      await waitFor(() => expect(screen.getByTestId('problem').textContent).toBe(vi_['iss.issueProblem.versionConflict.error']));
      expect(screen.getByRole('button', { name: vi_['iss.workspace.reload.action'] })).toBeTruthy();
    });

    it('AC-ST-ISS-003-1: does not offer the closing to the person who handled the issue, and says why (BR-ISS-05)', async () => {
      open(waiting({ assignee: person(1) }), HANDLER);
      await ready();
      expect(screen.getByTestId('independence').textContent).toBe(vi_['iss.verification.independence.notice']);
      expect(screen.queryByRole('button', { name: vi_['iss.verification.close.action'] })).toBeNull();
      expect(screen.queryByTestId('read-only')).toBeNull();
    });

    it('gives the result back with the reason and the handler, and withdraws nothing without a reason', async () => {
      const h = open(waiting(), VERIFIER);
      await ready();
      await waitFor(() => expect(within(screen.getByLabelText(vi_['iss.verification.refuse.assignee.label'])).getAllByRole('option').length).toBeGreaterThan(1));
      expect((screen.getByLabelText(vi_['iss.verification.refuse.assignee.label']) as HTMLSelectElement).value).toBe(person(2).membership_id);
      fireEvent.click(screen.getByRole('button', { name: vi_['iss.verification.refuse.action'] }));
      expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toContain(vi_['iss.field.required.error']);
      expect(h.command).not.toHaveBeenCalled();
      fireEvent.change(screen.getByLabelText(vi_['iss.verification.refuse.note.label']), { target: { value: ' Ảnh không thấy hàng rào ' } });
      fireEvent.click(screen.getByRole('button', { name: vi_['iss.verification.refuse.action'] }));
      expect((await screen.findByTestId('done')).textContent).toBe(vi_['iss.verification.refuse.done']);
      expect(h.command).toHaveBeenCalledWith('assignIssue', expect.objectContaining({ path: { id: waiting().id }, body: { assignee_id: person(2).membership_id, note: 'Ảnh không thấy hàng rào' }, ifMatchVersion: 4 }));
    });

    it('asks for the handler when the issue has none among the people it may be given to, and says when those cannot be read', async () => {
      open(waiting({ assignee: null }), VERIFIER, { failing: new Set(['listIssueAssignees']) });
      await ready();
      expect((await screen.findByTestId('members-unavailable')).textContent).toBe(vi_['iss.workspace.assign.members.error']);
      fireEvent.change(screen.getByLabelText(vi_['iss.verification.refuse.note.label']), { target: { value: 'Chưa đạt' } });
      fireEvent.click(screen.getByRole('button', { name: vi_['iss.verification.refuse.action'] }));
      expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toContain(vi_['iss.field.required.error']);
    });

    it('does not offer to give the result back to someone who cannot assign', async () => {
      open(waiting(), ['issue.read', 'issue.close']);
      await ready();
      expect(screen.getByRole('button', { name: vi_['iss.verification.close.action'] })).toBeTruthy();
      expect(screen.queryByRole('button', { name: vi_['iss.verification.refuse.action'] })).toBeNull();
    });

    it('says that the note of the handler is not shown with the rights of the reader, and that no document was named', async () => {
      open(waiting({ events: [event(1, 'CREATED'), event(2, 'VERIFICATION_REQUESTED', { note: null, actor: null, payload: {} })] }), VERIFIER);
      await ready();
      expect(screen.getByTestId('result-hidden').textContent).toBe(vi_['iss.workspace.description.hidden']);
      expect(screen.getByTestId('result-no-evidence').textContent).toBe(vi_['iss.verification.result.noEvidence.text']);
    });
  });

  describe('reopening', () => {
    const closed = (extra: Record<string, unknown> = {}) =>
      detail(1, { status: 'CLOSED', assignee: person(2), version: 5, closed_at: '2999-01-01T02:00:00.000Z', events: [event(1, 'CREATED'), event(2, 'CLOSED')], ...extra });

    it('reopens a closed issue with the reason, telling how long it can be reopened', async () => {
      const h = open(closed(), VERIFIER);
      await ready();
      // 30 days after 1 January 2999 at 09:00 Vietnam time.
      expect(screen.getByTestId('reopen-window').textContent).toContain('31/1/99');
      fireEvent.click(screen.getByRole('button', { name: vi_['iss.verification.reopen.action'] }));
      expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toContain(vi_['iss.field.required.error']);
      fireEvent.change(screen.getByLabelText(vi_['iss.verification.reopen.reason.label']), { target: { value: ' Hàng rào lại đổ ' } });
      fireEvent.click(screen.getByRole('button', { name: vi_['iss.verification.reopen.action'] }));
      expect((await screen.findByTestId('done')).textContent).toBe(vi_['iss.verification.reopen.done']);
      expect(h.command).toHaveBeenCalledWith('reopenIssue', expect.objectContaining({ path: { id: closed().id }, body: { reason: 'Hàng rào lại đổ' }, ifMatchVersion: 5 }));
    });

    it('says that the window has passed when the server refuses', async () => {
      const h = open(closed(), VERIFIER);
      h.command.mockRejectedValue(problem('REOPEN_WINDOW_EXPIRED', 422));
      await ready();
      fireEvent.change(screen.getByLabelText(vi_['iss.verification.reopen.reason.label']), { target: { value: 'Muộn' } });
      fireEvent.click(screen.getByRole('button', { name: vi_['iss.verification.reopen.action'] }));
      await waitFor(() => expect(screen.getByTestId('problem').textContent).toBe(vi_['iss.issueProblem.reopenWindow.error']));
    });
  });

  describe('what is offered', () => {
    it('offers nothing to someone who only reads, and says so', async () => {
      open(waiting(), READER);
      await ready();
      expect(screen.getByTestId('read-only').textContent).toBe(vi_['iss.verification.nothing.notice']);
      expect(screen.queryByRole('button', { name: vi_['iss.verification.close.action'] })).toBeNull();
    });

    it('offers nothing while the system is read-only', async () => {
      open(waiting(), VERIFIER, {}, 'READ_ONLY');
      await ready();
      expect(screen.getByTestId('read-only').textContent).toBe(vi_['iss.workspace.actions.frozen.notice']);
      expect(screen.queryByRole('button', { name: vi_['iss.verification.close.action'] })).toBeNull();
    });

    it('says when no issue is named, when it is not in the scope, and when the read fails', async () => {
      mountIssue(<IssueVerificationScreen route={ROUTE} />, client(world()), { permissions: READER, path: '/iss/iss-07' });
      expect((await screen.findByTestId('no-issue')).textContent).toBe(vi_['iss.workspace.noIssue.notice']);
      expect(screen.getByRole('link', { name: new RegExp(vi_['iss.back.list.link']) }).getAttribute('href')).toBe('/iss/iss-01');
      cleanup();
      mountIssue(<IssueVerificationScreen route={ROUTE} />, client(world({ details: [] })), { permissions: READER, path: '/iss/iss-07?id=00000000-0000-4000-8000-a20000000009' });
      expect(await screen.findByRole('alert')).toBeTruthy();
      cleanup();
      mountIssue(<IssueVerificationScreen route={ROUTE} />, client(world({ details: [detail(1)], failing: new Set(['get_resources_issue_id']) })), { permissions: READER, path: `/iss/iss-07?id=${String(detail(1).id)}` });
      expect(await screen.findByRole('alert')).toBeTruthy();
    });

    it('leads back to the workspace of the issue', async () => {
      open(waiting(), READER);
      await ready();
      expect(screen.getByRole('link', { name: new RegExp(vi_['iss.action.back.workspace.link']) }).getAttribute('href')).toBe(`/iss/iss-03?id=${String(waiting().id)}`);
    });
  });
});
