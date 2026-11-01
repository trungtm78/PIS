import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FAILURES } from '../../prj/closeout/test-support';
import { DOC, detail, fill, future, openApproval, problem, resetNetwork, row, sent, session, setOnline, word } from './test-support';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetNetwork();
});

const decision = () => screen.findByTestId('decision');
const open = async (): Promise<HTMLElement> => {
  fireEvent.click((await screen.findAllByRole('button', { name: word('doc.mobile.out.open.action') }))[0] as HTMLElement);
  const panel = await decision();
  await waitFor(() => expect(panel.querySelector('[data-status]') ?? panel.querySelector('h1')).not.toBeNull());
  return panel;
};
const start = (): HTMLElement => screen.getByRole('button', { name: word('doc.mobile.out.start.action') });

describe('MobileApprovalScreen (DOC-22): approving and signing on a phone', () => {
  it('UI-DOC-22: lists the documents waiting for the leader and opens one with its file, its signer and the way of signing', async () => {
    openApproval({ queue: [row(), row({ id: 'second', title: 'Công văn đi' })] });
    const list = await screen.findByTestId('waiting');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(word('doc.mobile.out.page.title'));
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(within(list).getAllByText(fill(word('doc.mobile.out.row.facts'), { type: 'QD', signer: 'Chủ tịch' }))).toHaveLength(2);
    const panel = await open();
    expect(within(panel).getByTestId('method').textContent).toBe(word('doc.outgoing.adapter.remoteCa'));
    expect(within(panel).getByTestId('file-facts').textContent).toBe(
      fill(word('doc.mobile.out.fact.version'), { version: 1, pages: 2, stage: word('doc.outgoing.stage.renderedFinal'), checksum: 'abababababab' }),
    );
    fireEvent.click(within(panel).getByRole('button', { name: word('doc.mobile.out.pdf.action') }));
    await waitFor(() =>
      expect(
        within(panel)
          .getByRole('link', { name: word('doc.mobile.out.pdf.link') })
          .getAttribute('href'),
      ).toBe('https://files.example/v1.pdf'),
    );
    fireEvent.click(within(panel).getByRole('button', { name: word('doc.mobile.out.close.action') }));
    expect(screen.queryByTestId('decision')).toBeNull();
  });

  it('opens a signing session through the remote authority only, with the certificate and the version that was read', async () => {
    const h = openApproval();
    await open();
    fireEvent.click(start());
    await waitFor(() => expect(sent(h, 'startLeaderSigning')).toHaveLength(1));
    expect(sent(h, 'startLeaderSigning')[0]).toMatchObject({ path: { id: DOC }, ifMatchVersion: 1, body: { certificate_id: 'c1', adapter_code: 'REMOTE_CA' } });
    expect((sent(h, 'startLeaderSigning')[0]?.attempt as { key: string }).key).toBeTruthy();
  });

  it('confirms an open session with the one-time code and says the document is signed', async () => {
    let state = detail({ sessions: [session()] });
    const h = openApproval({
      current: () => state,
      command: () => {
        state = detail({ status: 'SIGNED', leader_signed_at: new Date().toISOString(), sessions: [session({ status: 'EMBEDDED' })] });
        return { status: 'SIGNED', resource_id: 's1', resource_version: 2 };
      },
    });
    const panel = await open();
    expect(within(panel).getByText(/10 phút|9 phút/)).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', { name: word('doc.mobile.out.confirm.action') }));
    expect(within(panel).getByText(word('doc.mobile.out.otp.required'))).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(panel).getByLabelText(word('doc.mobile.out.otp.label')), { target: { value: ' 123456 ' } });
    fireEvent.click(within(panel).getByRole('button', { name: word('doc.mobile.out.confirm.action') }));
    await waitFor(() => expect(sent(h, 'completeSigningSession')).toHaveLength(1));
    expect(sent(h, 'completeSigningSession')[0]).toMatchObject({ path: { id: 's1' }, ifMatchVersion: 1, body: { otp_confirmation: '123456' } });
    expect((await within(panel).findByTestId('signed')).textContent).toBe(word('doc.mobile.out.signed.notice'));
    expect(within(panel).queryByRole('button', { name: word('doc.mobile.out.return.action') })).toBeNull();
  });

  it('AC-ST-DOC-020-1: UAT-AC426 refuses the completion of a session that ran out, says so, and keeps no signing command anywhere on the device', async () => {
    const h = openApproval({ current: () => detail({ sessions: [session({ expires_at: future(1) })] }), command: () => problem(409, 'SIGNING_SESSION_EXPIRED') });
    const panel = await open();
    fireEvent.change(within(panel).getByLabelText(word('doc.mobile.out.otp.label')), { target: { value: '123456' } });
    fireEvent.click(within(panel).getByRole('button', { name: word('doc.mobile.out.confirm.action') }));
    expect((await within(panel).findByTestId('refusal')).textContent).toBe(word('doc.outgoing.problem.expired'));
    expect(sent(h, 'completeSigningSession')).toHaveLength(1);
    expect(globalThis.localStorage.length).toBe(0);
    expect(globalThis.sessionStorage.length).toBe(0);
  });

  it('offers a new session when the last one has lapsed', async () => {
    const h = openApproval({ current: () => detail({ sessions: [session({ status: 'EXPIRED', expires_at: '2026-10-23T02:15:00Z', error_code: 'SIGNING_SESSION_EXPIRED' })] }) });
    const panel = await open();
    expect(within(panel).getByTestId('lapsed').textContent).toBe(word('doc.mobile.out.expired.notice'));
    fireEvent.click(within(panel).getByRole('button', { name: word('doc.mobile.out.restart.action') }));
    await waitFor(() => expect(sent(h, 'startLeaderSigning')).toHaveLength(1));
    expect(
      (await within(panel)
        .findByTestId('refusal')
        .catch(() => null)) === null,
    ).toBe(true);
  });

  it('shows the refusal of the start in words, and drops the one of the completion when a new start is made', async () => {
    openApproval({ command: () => problem(403, 'SIGNER_NOT_AUTHORIZED') });
    const panel = await open();
    fireEvent.click(start());
    expect((await within(panel).findByTestId('refusal')).textContent).toBe(word('doc.outgoing.problem.notSigner'));
  });

  it('says why nothing can be signed: not the signer, no certificate, or no right to sign', async () => {
    openApproval({ current: () => detail({ signer_user_id: 'someone-else' }) });
    let panel = await open();
    expect(within(panel).getByTestId('cannot-sign').textContent).toBe(word('doc.mobile.out.notSigner.notice'));
    cleanup();
    openApproval({ current: () => detail({ certificates: [] }) });
    panel = await open();
    expect(within(panel).getByTestId('cannot-sign').textContent).toBe(word('doc.mobile.out.cannotSign.notice'));
    cleanup();
    openApproval({ permissions: ['doc.outgoing.read'] });
    panel = await open();
    expect(within(panel).getByTestId('cannot-sign').textContent).toBe(word('doc.mobile.out.notSigner.notice'));
    expect(within(panel).queryByRole('button', { name: word('doc.mobile.out.return.action') })).toBeNull();
  });

  it('returns the document with a reason, to the drafter', async () => {
    const h = openApproval();
    const panel = await open();
    fireEvent.click(within(panel).getByRole('button', { name: word('doc.mobile.out.return.action') }));
    fireEvent.click(within(panel).getByRole('button', { name: word('doc.mobile.out.return.submit') }));
    expect(within(panel).getByText(word('doc.mobile.out.reason.required'))).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(panel).getByLabelText(word('doc.mobile.out.reason.label')), { target: { value: ' Sai thể thức ' } });
    fireEvent.click(within(panel).getByRole('button', { name: word('doc.mobile.out.return.submit') }));
    await waitFor(() => expect(sent(h, 'returnOutgoingDocument')).toHaveLength(1));
    expect(sent(h, 'returnOutgoingDocument')[0]).toMatchObject({ path: { id: DOC }, ifMatchVersion: 1, body: { reason: 'Sai thể thức' } });
    await waitFor(() => expect(screen.queryByTestId('decision')).toBeNull());
  });

  it('refuses a reason that is too long and shows the refusal of the return', async () => {
    const h = openApproval({ command: () => problem(409, 'DOCUMENT_STATE_INVALID') });
    const panel = await open();
    fireEvent.click(within(panel).getByRole('button', { name: word('doc.mobile.out.return.action') }));
    fireEvent.change(within(panel).getByLabelText(word('doc.mobile.out.reason.label')), { target: { value: 'x'.repeat(2001) } });
    fireEvent.click(within(panel).getByRole('button', { name: word('doc.mobile.out.return.submit') }));
    expect(within(panel).getByText(word('doc.mobile.out.reason.required'))).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(panel).getByLabelText(word('doc.mobile.out.reason.label')), { target: { value: 'Sai thể thức' } });
    fireEvent.click(within(panel).getByRole('button', { name: word('doc.mobile.out.return.submit') }));
    expect((await within(panel).findByTestId('refusal')).textContent).toBe(word('doc.outgoing.problem.state'));
  });

  it('has no signing and no return with no connection, says so, and keeps nothing for later', async () => {
    const h = openApproval();
    const panel = await open();
    setOnline(false);
    fireEvent(window, new Event('offline'));
    await waitFor(() => expect(within(panel).getByTestId('no-signing').textContent).toBe(word('doc.mobile.out.noSigning.notice')));
    expect(screen.getByTestId('offline-note').textContent).toBe(word('doc.mobile.out.offline.notice'));
    expect(within(panel).queryByRole('button', { name: word('doc.mobile.out.start.action') })).toBeNull();
    expect(within(panel).queryByRole('button', { name: word('doc.mobile.out.return.action') })).toBeNull();
    expect(h.command).not.toHaveBeenCalled();
    expect(globalThis.localStorage.length).toBe(0);
  });

  it('tells a person with no connection and nothing to show that they are offline', async () => {
    setOnline(false);
    openApproval();
    expect((await screen.findByText(word('states.offline.title'))).tagName).toBe('H1');
  });

  it('is read-only for a suspended tenant', async () => {
    openApproval({ mode: 'READ_ONLY' });
    const panel = await open();
    expect(within(panel).getByTestId('no-signing')).toBeTruthy();
  });

  it('shows the denied state and reads nothing without the permission to read documents', async () => {
    const h = openApproval({ permissions: ['doc.outgoing.sign'] });
    expect((await screen.findByText(word('states.denied.title'))).tagName).toBe('H1');
    expect(h.read).not.toHaveBeenCalled();
  });

  it('shows the empty state when no document waits for the leader', async () => {
    openApproval({ queue: [] });
    expect((await screen.findByText(word('states.empty.title'))).tagName).toBe('H1');
  });

  it('shows the loading state while the queue is on its way', () => {
    openApproval({ reads: () => new Promise(() => undefined) });
    expect(screen.getByRole('status', { name: word('states.loading.label') })).toBeTruthy();
  });

  it.each(FAILURES)('shows the %s state when the queue cannot be read, and reads again on retry', async (_name, failure, title) => {
    const h = openApproval({ reads: () => Promise.reject(failure) });
    expect((await screen.findByText(title)).tagName).toBe('H1');
    const before = h.read.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: word('states.retry.action') }));
    await waitFor(() => expect(h.read.mock.calls.length).toBeGreaterThan(before));
  });

  it('shows the state of the document when it cannot be read, and that the PDF could not be opened', async () => {
    openApproval({
      reads: (operation) => {
        if (operation === 'listOutgoingDocuments') return Promise.resolve({ items: [row()], next_cursor: null });
        return Promise.reject(problem(500, 'INTERNAL_ERROR'));
      },
    });
    const panel = await open();
    expect((await within(panel).findByText(word('states.error.title'))).tagName).toBe('H1');
    cleanup();
    openApproval({
      reads: (operation) => {
        if (operation === 'listOutgoingDocuments') return Promise.resolve({ items: [row()], next_cursor: null });
        if (operation === 'getOutgoingDocument') return Promise.resolve(detail());
        return Promise.reject(problem(500, 'INTERNAL_ERROR'));
      },
    });
    const second = await open();
    fireEvent.click(within(second).getByRole('button', { name: word('doc.mobile.out.pdf.action') }));
    expect((await within(second).findByText(word('doc.mobile.out.pdf.failed'))).tagName).toBe('P');
  });

  it('shows a document that has no file yet, and one that was signed before', async () => {
    openApproval({ current: () => detail({ versions: [], current_version_id: null }) });
    let panel = await open();
    expect(within(panel).getByTestId('file-facts').textContent).toBe(word('doc.mobile.out.fact.noFile'));
    expect(within(panel).queryByRole('button', { name: word('doc.mobile.out.pdf.action') })).toBeNull();
    cleanup();
    openApproval({ current: () => detail({ leader_signed_at: '2026-10-24T02:00:00Z' }) });
    panel = await open();
    expect(within(panel).getByTestId('signed')).toBeTruthy();
  });

  it('keeps the documents read when the next page cannot be read, and appends the page when it is asked for again', async () => {
    let failing = true;
    const h = openApproval({
      reads: (operation, input) => {
        if (operation !== 'listOutgoingDocuments') return Promise.resolve(detail());
        if ((input as { query: { cursor?: string } }).query.cursor === undefined) return Promise.resolve({ items: [row({ id: 'd1', title: 'Văn bản 1' })], next_cursor: 'c2' });
        return failing ? Promise.reject(new Error('down')) : Promise.resolve({ items: [row({ id: 'd2', title: 'Văn bản 2' })], next_cursor: null });
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: word('doc.mobile.out.more.action') }));
    expect((await screen.findByTestId('more-failed')).textContent).toContain(word('doc.mobile.out.moreFailed.notice'));
    expect(within(screen.getByTestId('waiting')).getAllByRole('listitem')).toHaveLength(1);
    expect(screen.queryByText(word('states.error.title'))).toBeNull();
    failing = false;
    fireEvent.click(screen.getByRole('button', { name: word('doc.mobile.out.moreRetry.action') }));
    await waitFor(() => expect(within(screen.getByTestId('waiting')).getAllByRole('listitem')).toHaveLength(2));
    expect(screen.queryByTestId('more-failed')).toBeNull();
    expect(h.read.mock.calls.filter(([name]) => name === 'listOutgoingDocuments')).toHaveLength(3);
  });

  it('opens the document named in the address and pages through the queue', async () => {
    let calls = 0;
    const h = openApproval({
      path: `/doc/doc-22?doc=${DOC}`,
      reads: (operation, input) => {
        if (operation === 'listOutgoingDocuments') {
          calls += 1;
          return Promise.resolve({ items: [row({ id: `d${calls}`, title: `Văn bản ${calls}` })], next_cursor: (input as { query: { cursor?: string } }).query.cursor === undefined ? 'c2' : null });
        }
        return Promise.resolve(detail());
      },
    });
    expect((await decision()).getAttribute('data-testid')).toBe('decision');
    fireEvent.click(await screen.findByRole('button', { name: word('doc.mobile.out.more.action') }));
    await waitFor(() => expect(within(screen.getByTestId('waiting')).getAllByRole('listitem')).toHaveLength(2));
    expect(h.read.mock.calls.filter(([name]) => name === 'listOutgoingDocuments')).toHaveLength(2);
  });
});
