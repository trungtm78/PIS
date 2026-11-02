import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import OcrScreen from './OcrScreen';
import { KEY, NOBODY, READER, REVIEWER, client, mount, pack, packageId, page, pageId, proposal, proposalId, routeOf, versionId, waiting, world } from './test-support';
import type { World } from './test-support';

const ROUTE = routeOf('BID-06', 'FR-BID-06');
const OK = { operation_id: 'o', status: 'CORRECTED', resource_version: 1, resource_id: pageId(23) };
const problem = (code: string, status = 422, extensions: Record<string, unknown> = {}) => new ApiError({ status, code, correlationId: 'c', extensions });
const text = (key: string, params: Record<string, string | number> = {}): string =>
  Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);

/** The moment as the screen words it (the language of the tests is Vietnamese). */
const moment = (iso: string): string => new Intl.DateTimeFormat('vi', { dateStyle: 'short', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(iso));
/** The text of a file the screen sent (the file of the test browser has no text method). */
const textOf = (file: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

interface Options {
  permissions?: readonly string[];
  mode?: 'FULL' | 'READ_ONLY';
  path?: string;
  command?: (operation: string, input: unknown) => unknown;
  upload?: () => unknown;
}

const PATH = `/bid/bid-06?package=${packageId(1)}&proposal=${proposalId(1)}`;

function open(state: World, options: Options = {}) {
  const h = client(state, options.command ?? (() => OK), options.upload);
  mount(<OcrScreen route={ROUTE} />, h, { permissions: options.permissions ?? REVIEWER, path: options.path ?? PATH, ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return h;
}

/** A proposal of forty pages of which page 23 was read at 0.71 and waits for an expert. */
const withPage23 = (): World => world({ pages: [page(1), page(2, { table_mismatch: false }), waiting(23, { document_version_id: versionId(1) })] });
const cardOf = (id: string): HTMLElement => document.querySelector(`[data-page="${id}"]`) as HTMLElement;
const textarea = (id: string): HTMLTextAreaElement => within(cardOf(id)).getByRole('textbox', { name: /Nội dung đúng của trang/ }) as HTMLTextAreaElement;
const type = (id: string, value: string): void => {
  fireEvent.change(textarea(id), { target: { value } });
};
const click = (id: string, key: string): void => {
  fireEvent.click(within(cardOf(id)).getByRole('button', { name: vi_[key as keyof typeof vi_] }));
};

describe('OcrScreen (BID-06): the OCR review of the pages of a proposal', () => {
  describe('the standard states of the screen', () => {
    it('UI-BID-06: shows the loading state, then asks for a package and offers the packages that are open for bids', async () => {
      open(world(), { path: '/bid/bid-06' });
      expect(screen.getByRole('status', { busy: true })).toBeTruthy();
      expect((await screen.findByTestId('choose-package')).textContent).toBe(vi_['bid.ocr.package.hint']);
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['bid.ocr.page.title']);
      expect(Array.from((document.getElementById('ocr-package') as HTMLSelectElement).options).map((option) => option.textContent)).toEqual([
        vi_['bid.ocr.package.choose'],
        'GT-1 · Gói thầu xây lắp 1',
        'GT-2 · Gói thầu xây lắp 2',
      ]);
      expect(screen.getByText(text('bid.ocr.footer.reference', { id: 'BID-06', req: 'FR-BID-06' }))).toBeTruthy();
    });

    it('UI-BID-06: shows the empty state when no package is open for bids', async () => {
      open(world({ packages: [] }), { path: '/bid/bid-06' });
      expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
    });

    it('UI-BID-06: shows the error state with a retry that reads again', async () => {
      const state = world();
      state.failing.set('get_resources_procurement_package', new Error('down'));
      const h = open(state, { path: '/bid/bid-06' });
      expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
      state.failing.clear();
      fireEvent.click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
      expect(await screen.findByTestId('choose-package')).toBeTruthy();
      expect((h.client.readAll as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('UI-BID-06: shows the offline state and the signed-out state for the failures that are those', async () => {
      const offline = world();
      offline.failing.set('get_resources_procurement_package', problem(NETWORK_ERROR_CODE, 0));
      open(offline, { path: '/bid/bid-06' });
      expect(await screen.findByText(vi_['states.offline.title'])).toBeTruthy();
      cleanup();
      const lapsed = world();
      lapsed.failing.set('get_resources_procurement_package', problem('SESSION_EXPIRED', 401));
      open(lapsed, { path: '/bid/bid-06' });
      expect(await screen.findByText(vi_['states.signedOut.title'])).toBeTruthy();
    });

    it('UI-BID-06: shows the denied state to a caller without the right to read the OCR, and when the server refuses the pages', async () => {
      open(world(), { permissions: NOBODY, path: '/bid/bid-06' });
      expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
      cleanup();
      const state = withPage23();
      state.failing.set('listProposalOcrPages', problem('CONFLICT_UNDECLARED', 403));
      open(state);
      expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
    });

    it('UI-BID-06: shows the error state of the pages with a retry, and the filters stay where they are', async () => {
      const state = withPage23();
      state.failing.set('listProposalOcrPages', new Error('down'));
      open(state);
      expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
      expect(document.getElementById('ocr-status')).toBeTruthy();
      state.failing.clear();
      fireEvent.click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
      expect(await screen.findByTestId('pages')).toBeTruthy();
    });

    it('offers only the proposals the caller has in full, says when there are none and when the proposals cannot be read', async () => {
      open(world({ pages: [page(1)] }), { path: `/bid/bid-06?package=${packageId(1)}` });
      const select = (await screen.findByLabelText(vi_['bid.ocr.proposal.label'])) as HTMLSelectElement;
      expect(Array.from(select.options).map((option) => option.textContent)).toEqual([vi_['bid.ocr.proposal.choose'], text('bid.ocr.proposal.option', { name: 'Công ty nhà thầu 1', revision: 1 })]);
      expect(document.getElementById('ocr-status')).toBeNull();
      fireEvent.change(select, { target: { value: proposalId(1) } });
      expect(await screen.findByTestId('pages')).toBeTruthy();
      fireEvent.change(document.getElementById('ocr-package') as HTMLElement, { target: { value: packageId(2) } });
      expect((await screen.findByTestId('no-proposals')).textContent).toBe(vi_['bid.ocr.proposals.none']);
      cleanup();
      const failing = world();
      failing.failing.set('get_resources_proposal', new Error('down'));
      open(failing, { path: `/bid/bid-06?package=${packageId(1)}` });
      expect((await screen.findByTestId('proposals-error')).textContent).toContain(vi_['bid.ocr.proposals.error']);
      failing.failing.clear();
      fireEvent.click(screen.getByRole('button', { name: vi_['bid.ocr.retry.action'] }));
      expect(await screen.findByLabelText(vi_['bid.ocr.proposal.label'])).toBeTruthy();
    });

    it('offers the packages that were open for bids, awarded or not, and not the ones that never were', async () => {
      const packages = [pack(1), pack(2, { status: 'AWARDED' }), pack(3, { status: 'NO_ACCEPTABLE_BID' }), pack(4, { status: 'CANCELLED' }), pack(5, { status: 'DRAFT' }), pack(6, { status: 'IN_REVIEW' }), pack(7, { status: 'SUPERSEDED' })];
      open(world({ packages, proposals: [proposal(1, 2)], pages: [page(1)] }), { path: `/bid/bid-06?package=${packageId(2)}&proposal=${proposalId(1)}` });
      expect(await screen.findByTestId('pages')).toBeTruthy();
      const select = document.getElementById('ocr-package') as HTMLSelectElement;
      expect(Array.from(select.options).map((option) => option.value).filter((value) => value !== '')).toEqual([1, 2, 3, 4].map(packageId));
    });

    it('ignores a package or a proposal of the address that is not on offer', async () => {
      open(world(), { path: `/bid/bid-06?package=${packageId(3)}&proposal=${proposalId(1)}` });
      expect(await screen.findByTestId('choose-package')).toBeTruthy();
      cleanup();
      open(world({ pages: [page(1)] }), { path: `/bid/bid-06?package=${packageId(1)}&proposal=${proposalId(2)}` });
      expect(await screen.findByLabelText(vi_['bid.ocr.proposal.label'])).toBeTruthy();
      expect(screen.queryByTestId('pages')).toBeNull();
    });
  });

  describe('the pages, side by side', () => {
    it('shows each page with its number, its confidence, its status and the text the engine recognised, and the pages that wait with the form of the reviewer', async () => {
      open(withPage23());
      await screen.findByTestId('pages');
      const late = cardOf(pageId(23));
      expect(within(late).getByRole('heading', { level: 3 }).textContent).toBe(text('bid.ocr.page.heading', { page: 23, file: 'Đề xuất tài chính' }));
      expect(within(late).getByTestId('confidence').textContent).toBe(text('bid.ocr.confidence.text', { value: '71%' }));
      expect(within(late).getByTestId('status').textContent).toBe(vi_['bid.ocr.status.needsReview']);
      expect(within(late).getByTestId('engine-text').textContent).toContain('2.000.OOO');
      expect(textarea(pageId(23)).value).toContain('2.000.OOO');
      expect(within(cardOf(pageId(1))).getByTestId('status').textContent).toBe(vi_['bid.ocr.status.autoAccepted']);
      expect(within(cardOf(pageId(1))).getByTestId('accepted').textContent).toBe(vi_['bid.ocr.accepted.text']);
      expect(within(cardOf(pageId(1))).queryByTestId('review-form')).toBeNull();
    });

    it('AC-ST-BID-008-1, UAT-AC449: holds the financial analysis back while page 23 waits, and lets it go when the expert has corrected it', async () => {
      const state = withPage23();
      const h = open(state, {
        command: () => {
          const waitingPage = state.pages.find((item) => item.id === pageId(23)) as Record<string, unknown>;
          Object.assign(waitingPage, { review_status: 'CORRECTED', reviewed_by: 'm', reviewed_at: '2026-12-05T03:00:00.000Z', corrected_text: 'Tổng cộng: 1.000.000 + 2.000.000 = 3.000.000' });
          return OK;
        },
      });
      expect((await screen.findByTestId('gate-blocked')).textContent).toBe(text('bid.ocr.gate.blocked', { count: 1, threshold: '85%' }));
      expect(screen.queryByTestId('gate-ready')).toBeNull();
      type(pageId(23), 'Tổng cộng: 1.000.000 + 2.000.000 = 3.000.000');
      fireEvent.change(within(cardOf(pageId(23))).getByLabelText(vi_['bid.ocr.note.label']), { target: { value: ' Đã đối chiếu với bản quét. ' } });
      click(pageId(23), 'bid.ocr.correct.action');
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      // The corrected text goes through the upload pipeline as plain text, and the review names what the pipeline stored.
      expect(h.upload).toHaveBeenCalledTimes(1);
      const form = (h.upload.mock.calls[0] as [string, { form: FormData }])[1].form;
      expect(h.upload.mock.calls[0]?.[0]).toBe('uploadOcrCorrectionFile');
      const sent = form.get('file') as File;
      expect(sent.type).toBe('text/plain');
      expect(await textOf(sent)).toBe('Tổng cộng: 1.000.000 + 2.000.000 = 3.000.000');
      expect(h.command).toHaveBeenCalledWith(
        'reviewOcrPage',
        expect.objectContaining({ path: { id: pageId(23) }, body: { decision: 'CORRECTED', corrected_text_object_key: KEY, note: 'Đã đối chiếu với bản quét.' }, attempt: expect.anything() }),
      );
      expect((await screen.findByTestId('gate-ready')).textContent).toBe(vi_['bid.ocr.gate.ready']);
      expect(screen.queryByTestId('gate-blocked')).toBeNull();
      const done = cardOf(pageId(23));
      expect(within(done).getByTestId('status').textContent).toBe(vi_['bid.ocr.status.corrected']);
      expect(within(done).getByTestId('corrected-text').textContent).toBe('Tổng cộng: 1.000.000 + 2.000.000 = 3.000.000');
      expect(within(done).queryByTestId('review-form')).toBeNull();
    });

    it('shows a table that does not add up beside the page, and the outcome of a confirmed page with the words of the reviewer', async () => {
      open(
        world({
          pages: [
            waiting(4, { table_mismatch: true, ocr_confidence: '0.9900' }),
            page(5, { review_status: 'CONFIRMED', reviewed_by: 'm', reviewed_at: '2026-12-04T03:00:00.000Z', note: 'Đúng với bản gốc.' }),
          ],
        }),
      );
      await screen.findByTestId('pages');
      expect(within(cardOf(pageId(4))).getByTestId('mismatch').textContent).toBe(vi_['bid.ocr.mismatch.badge']);
      expect(within(cardOf(pageId(4))).getByTestId('confidence').textContent).toBe(text('bid.ocr.confidence.text', { value: '99%' }));
      const confirmed = cardOf(pageId(5));
      expect(within(confirmed).queryByTestId('mismatch')).toBeNull();
      expect(within(confirmed).getByTestId('outcome').textContent).toContain(text('bid.ocr.reviewed.confirmed', { date: moment('2026-12-04T03:00:00.000Z') }));
      expect(within(confirmed).getByTestId('review-note').textContent).toContain('Đúng với bản gốc.');
      expect(within(confirmed).queryByTestId('corrected-text')).toBeNull();
    });

    it('says why the recognised text is not shown, and offers no confirmation of a text nobody can read', async () => {
      open(world({ pages: [waiting(7, { text: null, text_state: 'DIGEST_MISMATCH' }), waiting(8, { text: null, text_state: 'MISSING' })] }));
      await screen.findByTestId('pages');
      expect(within(cardOf(pageId(7))).getByTestId('text-state').textContent).toBe(vi_['bid.ocr.textState.digestMismatch']);
      expect(within(cardOf(pageId(8))).getByTestId('text-state').textContent).toBe(vi_['bid.ocr.textState.missing']);
      expect(within(cardOf(pageId(7))).queryByTestId('engine-text')).toBeNull();
      expect(within(cardOf(pageId(7))).getByTestId('confirm-unreadable').textContent).toBe(vi_['bid.ocr.confirm.unreadable']);
      expect((within(cardOf(pageId(7))).getByRole('button', { name: vi_['bid.ocr.confirm.action'] }) as HTMLButtonElement).disabled).toBe(true);
      expect((within(cardOf(pageId(7))).getByRole('button', { name: vi_['bid.ocr.correct.action'] }) as HTMLButtonElement).disabled).toBe(true);
      type(pageId(7), 'Nội dung đúng');
      expect((within(cardOf(pageId(7))).getByRole('button', { name: vi_['bid.ocr.correct.action'] }) as HTMLButtonElement).disabled).toBe(false);
    });

    it('says nothing about the analysis for a proposal with no page recorded yet', async () => {
      open(world());
      expect((await screen.findByTestId('no-pages')).textContent).toBe(vi_['bid.ocr.none.notice']);
      expect(screen.queryByTestId('gate-ready')).toBeNull();
      expect(screen.queryByTestId('gate-blocked')).toBeNull();
    });
  });

  describe('confirming and correcting a page', () => {
    it('confirms a page as it was recognised, with one command and no upload', async () => {
      const state = withPage23();
      const h = open(state, { command: () => ({ ...OK, status: 'CONFIRMED' }) });
      await screen.findByTestId('pages');
      fireEvent.change(within(cardOf(pageId(23))).getByLabelText(vi_['bid.ocr.note.label']), { target: { value: 'Đã xem bản quét.' } });
      click(pageId(23), 'bid.ocr.confirm.action');
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command).toHaveBeenCalledWith('reviewOcrPage', expect.objectContaining({ path: { id: pageId(23) }, body: { decision: 'CONFIRMED', note: 'Đã xem bản quét.' } }));
      expect(h.upload).not.toHaveBeenCalled();
    });

    it('offers the confirmation only for a text left as it was, and the correction only for a text that was changed', async () => {
      const h = open(withPage23());
      await screen.findByTestId('pages');
      const confirm = within(cardOf(pageId(23))).getByRole('button', { name: vi_['bid.ocr.confirm.action'] }) as HTMLButtonElement;
      const correct = within(cardOf(pageId(23))).getByRole('button', { name: vi_['bid.ocr.correct.action'] }) as HTMLButtonElement;
      expect([confirm.disabled, correct.disabled]).toEqual([false, true]);
      expect(within(cardOf(pageId(23))).queryByTestId('edited-hint')).toBeNull();
      type(pageId(23), 'Nội dung khác');
      expect([confirm.disabled, correct.disabled]).toEqual([true, false]);
      expect(within(cardOf(pageId(23))).getByTestId('edited-hint').textContent).toBe(vi_['bid.ocr.edited.hint']);
      fireEvent.click(confirm);
      expect(h.command).not.toHaveBeenCalled();
    });

    it('does not send a correction that is empty, and a note that is too long, and says why', async () => {
      const h = open(withPage23());
      await screen.findByTestId('pages');
      type(pageId(23), '   ');
      fireEvent.submit(within(cardOf(pageId(23))).getByTestId('review-form'));
      expect(within(cardOf(pageId(23))).getByText(vi_['bid.ocr.problem.required'])).toBeTruthy();
      type(pageId(23), 'Nội dung khác');
      fireEvent.change(within(cardOf(pageId(23))).getByLabelText(vi_['bid.ocr.note.label']), { target: { value: 'x'.repeat(1001) } });
      click(pageId(23), 'bid.ocr.correct.action');
      expect(within(cardOf(pageId(23))).getByText(vi_['bid.ocr.problem.noteTooLong'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
      expect(h.upload).not.toHaveBeenCalled();
    });

    it('submits the form of an unchanged page as a confirmation', async () => {
      const h = open(withPage23(), { command: () => ({ ...OK, status: 'CONFIRMED' }) });
      await screen.findByTestId('pages');
      fireEvent.submit(within(cardOf(pageId(23))).getByTestId('review-form'));
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('reviewOcrPage', expect.objectContaining({ body: { decision: 'CONFIRMED' } })));
    });

    it('never loses what was typed: a refusal keeps the text and the note, says why, and a later retry is the same request (same idempotency key)', async () => {
      let calls = 0;
      const h = open(withPage23(), {
        command: () => {
          calls += 1;
          return calls === 1 ? problem('INTERNAL_ERROR', 500) : OK;
        },
      });
      await screen.findByTestId('pages');
      type(pageId(23), 'Tổng cộng: 3.000.000');
      fireEvent.change(within(cardOf(pageId(23))).getByLabelText(vi_['bid.ocr.note.label']), { target: { value: 'Ghi chú của tôi' } });
      click(pageId(23), 'bid.ocr.correct.action');
      expect((await within(cardOf(pageId(23))).findByTestId('refusal')).textContent).toBe(vi_['bid.ocr.error.general']);
      expect(textarea(pageId(23)).value).toBe('Tổng cộng: 3.000.000');
      expect((within(cardOf(pageId(23))).getByLabelText(vi_['bid.ocr.note.label']) as HTMLInputElement).value).toBe('Ghi chú của tôi');
      click(pageId(23), 'bid.ocr.correct.action');
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
      const keys = h.command.mock.calls.map((call) => (call[1] as { attempt: { key: string } }).attempt.key);
      expect(keys[0]).toBe(keys[1]);
      const uploads = h.upload.mock.calls.map((call) => (call[1] as { attempt: { key: string } }).attempt.key);
      expect(uploads[0]).toBe(uploads[1]);
    });

    it('keeps the attempts of a page to itself: two pages corrected with the same text use keys of their own, and the failure of one is retried with its own key after the other went through', async () => {
      const state = world({ pages: [waiting(23), waiting(24)] });
      let sent = 0;
      const h = open(state, {
        command: () => {
          sent += 1;
          return sent === 1 ? problem('INTERNAL_ERROR', 500) : OK;
        },
      });
      await screen.findByTestId('pages');
      type(pageId(23), 'Cùng một nội dung');
      type(pageId(24), 'Cùng một nội dung');
      click(pageId(23), 'bid.ocr.correct.action');
      await within(cardOf(pageId(23))).findByTestId('refusal');
      click(pageId(24), 'bid.ocr.correct.action');
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
      click(pageId(23), 'bid.ocr.correct.action');
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(3));
      const keysOf = (list: Array<unknown[]>): string[] => list.map((call) => (call[1] as { attempt: { key: string } }).attempt.key);
      const commands = keysOf(h.command.mock.calls);
      const uploads = keysOf(h.upload.mock.calls);
      expect(commands[0]).not.toBe(commands[1]);
      expect(commands[2]).toBe(commands[0]);
      expect(uploads[0]).not.toBe(uploads[1]);
      expect(uploads[2]).toBe(uploads[0]);
    });

    it('sends one review at a time: while a page is being sent its fields are fixed and the other pages cannot be sent, and they can once the answer is in', async () => {
      let answer: (value: unknown) => void = () => undefined;
      const h = open(world({ pages: [waiting(23), waiting(24)] }), { command: () => new Promise((resolve) => (answer = resolve)) });
      await screen.findByTestId('pages');
      type(pageId(23), 'Bản sửa của trang 23');
      type(pageId(24), 'Bản sửa của trang 24');
      click(pageId(23), 'bid.ocr.correct.action');
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(textarea(pageId(23)).readOnly).toBe(true);
      expect((within(cardOf(pageId(23))).getByLabelText(vi_['bid.ocr.note.label']) as HTMLInputElement).readOnly).toBe(true);
      const other = within(cardOf(pageId(24))).getByRole('button', { name: vi_['bid.ocr.correct.action'] }) as HTMLButtonElement;
      expect(other.disabled).toBe(true);
      fireEvent.submit(other.closest('form') as HTMLFormElement);
      expect(h.command).toHaveBeenCalledTimes(1);
      answer(OK);
      await waitFor(() => expect(textarea(pageId(24)).readOnly).toBe(false));
      expect(textarea(pageId(24)).value).toBe('Bản sửa của trang 24');
      expect((within(cardOf(pageId(24))).getByRole('button', { name: vi_['bid.ocr.correct.action'] }) as HTMLButtonElement).disabled).toBe(false);
    });

    it('words the refusals of the server and keeps the draft for each', async () => {
      const cases: Array<[string, number, Record<string, unknown>, string]> = [
        ['OCR_STATE_INVALID', 409, {}, vi_['bid.ocr.error.state']],
        ['CONFLICT_UNDECLARED', 403, {}, vi_['bid.ocr.error.undeclared']],
        ['VALIDATION_FAILED', 422, { reason: 'FILE_ALREADY_ATTACHED' }, vi_['bid.ocr.error.file']],
        ['VALIDATION_FAILED', 422, {}, vi_['bid.ocr.error.validation']],
        ['RESOURCE_NOT_FOUND', 404, {}, vi_['bid.ocr.error.notFound']],
        ['SCOPE_DENIED', 403, {}, vi_['bid.ocr.error.denied']],
        ['SESSION_EXPIRED', 401, {}, vi_['bid.ocr.error.session']],
      ];
      for (const [code, status, extensions, message] of cases) {
        cleanup();
        open(withPage23(), { command: () => problem(code, status, extensions) });
        await screen.findByTestId('pages');
        type(pageId(23), 'Nội dung đã sửa');
        click(pageId(23), 'bid.ocr.correct.action');
        expect((await within(cardOf(pageId(23))).findByTestId('refusal')).textContent).toBe(message);
        expect(textarea(pageId(23)).value).toBe('Nội dung đã sửa');
      }
    });

    it('words the refusals of the upload of the corrected text, and sends no review', async () => {
      const cases: Array<[string, number, string]> = [
        ['FILE_TYPE_NOT_ALLOWED', 422, vi_['bid.ocr.error.fileType']],
        ['PAYLOAD_TOO_LARGE', 413, vi_['bid.ocr.error.tooLarge']],
        ['FILE_NOT_CLEAN', 422, vi_['bid.ocr.error.notClean']],
        ['SCAN_PENDING', 409, vi_['bid.ocr.error.scan']],
      ];
      for (const [code, status, message] of cases) {
        cleanup();
        const h = open(withPage23(), { upload: () => problem(code, status) });
        await screen.findByTestId('pages');
        type(pageId(23), 'Nội dung đã sửa');
        click(pageId(23), 'bid.ocr.correct.action');
        expect((await within(cardOf(pageId(23))).findByTestId('refusal')).textContent).toBe(message);
        expect(h.command).not.toHaveBeenCalled();
      }
    });

    it('refuses to review when the upload does not name the stored text', async () => {
      const h = open(withPage23(), { upload: () => ({}) });
      await screen.findByTestId('pages');
      type(pageId(23), 'Nội dung đã sửa');
      click(pageId(23), 'bid.ocr.correct.action');
      expect((await within(cardOf(pageId(23))).findByTestId('refusal')).textContent).toBe(vi_['bid.ocr.error.general']);
      expect(h.command).not.toHaveBeenCalled();
    });

    it('keeps the draft of a page across a change of the filters and a refresh of the list, and drops it once the page is reviewed', async () => {
      const state = world({ pages: [waiting(23), waiting(24), page(1, { review_status: 'CONFIRMED', reviewed_by: 'm', reviewed_at: '2026-12-04T03:00:00.000Z' })] });
      open(state, {
        command: () => {
          Object.assign(state.pages[0] as Record<string, unknown>, { review_status: 'CORRECTED', reviewed_by: 'm', reviewed_at: '2026-12-05T03:00:00.000Z', corrected_text: 'Bản sửa của trang 23' });
          return OK;
        },
      });
      await screen.findByTestId('pages');
      type(pageId(24), 'Bản nháp của trang 24');
      fireEvent.change(document.getElementById('ocr-status') as HTMLElement, { target: { value: 'CONFIRMED' } });
      await waitFor(() => expect(document.querySelector(`[data-page="${pageId(24)}"]`)).toBeNull());
      fireEvent.change(document.getElementById('ocr-status') as HTMLElement, { target: { value: 'NEEDS_REVIEW' } });
      await waitFor(() => expect(document.querySelector(`[data-page="${pageId(24)}"]`)).not.toBeNull());
      expect(textarea(pageId(24)).value).toBe('Bản nháp của trang 24');
      type(pageId(23), 'Bản sửa của trang 23');
      click(pageId(23), 'bid.ocr.correct.action');
      await waitFor(() => expect(document.querySelector(`[data-page="${pageId(23)}"]`)).toBeNull());
      expect(textarea(pageId(24)).value).toBe('Bản nháp của trang 24');
    });

    it('writes none of the text to the console', async () => {
      const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
      const h = open(withPage23(), { command: () => problem('INTERNAL_ERROR', 500) });
      await screen.findByTestId('pages');
      type(pageId(23), 'NỘI-DUNG-BÍ-MẬT');
      fireEvent.change(within(cardOf(pageId(23))).getByLabelText(vi_['bid.ocr.note.label']), { target: { value: 'GHI-CHÚ-BÍ-MẬT' } });
      click(pageId(23), 'bid.ocr.correct.action');
      await within(cardOf(pageId(23))).findByTestId('refusal');
      expect(h.command).toHaveBeenCalled();
      const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls.map((call) => call.map(String))));
      expect(logged).not.toContain('NỘI-DUNG-BÍ-MẬT');
      expect(logged).not.toContain('GHI-CHÚ-BÍ-MẬT');
    });
  });

  describe('who is offered what', () => {
    it('shows the pages and no form to a reader, and to a read-only session', async () => {
      open(withPage23(), { permissions: READER });
      await screen.findByTestId('pages');
      expect(within(cardOf(pageId(23))).getByTestId('waiting').textContent).toBe(vi_['bid.ocr.waiting.text']);
      expect(within(cardOf(pageId(23))).queryByTestId('review-form')).toBeNull();
      expect(within(cardOf(pageId(23))).getByTestId('engine-text')).toBeTruthy();
      cleanup();
      open(withPage23(), { permissions: REVIEWER, mode: 'READ_ONLY' });
      await screen.findByTestId('pages');
      expect(within(cardOf(pageId(23))).queryByTestId('review-form')).toBeNull();
    });
  });

  describe('the filters', () => {
    it('keep their place when nothing matches, say so, and clear', async () => {
      open(withPage23());
      await screen.findByTestId('pages');
      fireEvent.change(document.getElementById('ocr-status') as HTMLElement, { target: { value: 'CORRECTED' } });
      expect((await screen.findByTestId('no-pages')).textContent).toBe(vi_['bid.ocr.none.filtered']);
      expect(document.getElementById('ocr-status')).toBeTruthy();
      expect(screen.getByTestId('gate-blocked')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: vi_['bid.ocr.filter.clear'] }));
      expect(await screen.findByTestId('pages')).toBeTruthy();
      expect(screen.queryByRole('button', { name: vi_['bid.ocr.filter.clear'] })).toBeNull();
    });

    it('narrow the pages to a status and to a file, and offer the files of the proposal with their pages', async () => {
      const state = world({ pages: [waiting(23), page(1), page(9, { document_version_id: versionId(2) })] });
      open(state);
      await screen.findByTestId('pages');
      expect(Array.from((document.getElementById('ocr-file') as HTMLSelectElement).options).map((option) => option.textContent)).toEqual([
        vi_['bid.ocr.filter.file.all'],
        text('bid.ocr.filter.file.option', { title: 'Đề xuất tài chính', pages: 30 }),
        text('bid.ocr.filter.file.option', { title: 'Đề xuất kỹ thuật', pages: 120 }),
      ]);
      fireEvent.change(document.getElementById('ocr-file') as HTMLElement, { target: { value: versionId(2) } });
      await waitFor(() => expect(Array.from(document.querySelectorAll('[data-page]')).map((card) => card.getAttribute('data-page'))).toEqual([pageId(9)]));
      expect(within(cardOf(pageId(9))).getByRole('heading', { level: 3 }).textContent).toBe(text('bid.ocr.page.heading', { page: 9, file: 'Đề xuất kỹ thuật' }));
      fireEvent.change(document.getElementById('ocr-file') as HTMLElement, { target: { value: '' } });
      fireEvent.change(document.getElementById('ocr-status') as HTMLElement, { target: { value: 'NEEDS_REVIEW' } });
      await waitFor(() => expect(Array.from(document.querySelectorAll('[data-page]')).map((card) => card.getAttribute('data-page'))).toEqual([pageId(23)]));
      expect(Array.from((document.getElementById('ocr-status') as HTMLSelectElement).options).map((option) => option.textContent)).toEqual([
        vi_['bid.ocr.filter.status.all'],
        vi_['bid.ocr.status.autoAccepted'],
        vi_['bid.ocr.status.needsReview'],
        vi_['bid.ocr.status.confirmed'],
        vi_['bid.ocr.status.corrected'],
      ]);
    });

    it('start over when the package or the proposal changes', async () => {
      open(withPage23(), { path: `${PATH}&status=NEEDS_REVIEW` });
      await screen.findByTestId('pages');
      expect((document.getElementById('ocr-status') as HTMLSelectElement).value).toBe('NEEDS_REVIEW');
      fireEvent.change(document.getElementById('ocr-proposal') as HTMLElement, { target: { value: '' } });
      await waitFor(() => expect(screen.queryByTestId('pages')).toBeNull());
      expect(document.getElementById('ocr-status')).toBeNull();
      fireEvent.change(document.getElementById('ocr-package') as HTMLElement, { target: { value: '' } });
      expect(await screen.findByTestId('choose-package')).toBeTruthy();
    });
  });

  describe('the list in pages', () => {
    it('loads the next pages on request, and the gate stays that of the whole proposal', async () => {
      const state = world({ pages: [page(1), page(2), waiting(23)], pageSize: 2 });
      open(state);
      await screen.findByTestId('pages');
      expect(document.querySelectorAll('[data-page]')).toHaveLength(2);
      expect(screen.getByTestId('gate-blocked').textContent).toBe(text('bid.ocr.gate.blocked', { count: 1, threshold: '85%' }));
      fireEvent.click(screen.getByRole('button', { name: vi_['bid.ocr.loadMore.action'] }));
      await waitFor(() => expect(document.querySelectorAll('[data-page]')).toHaveLength(3));
      expect(screen.queryByRole('button', { name: vi_['bid.ocr.loadMore.action'] })).toBeNull();
    });
  });
});
