import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { translator } from '../../../i18n';
import ReviewBoardScreen from './ReviewBoardScreen';
import { DOCUMENT, REVIEW, VERSION_1, client, mountScreen, reviewDetail, reviewItem, reviewer, route, round, uuid, world } from './test/repo-test-support';
import type { World } from './test/repo-test-support';

const problem = (code: string, status: number) => new ApiError({ status, code, correlationId: 'c' });
const t = (key: string, params: Record<string, string | number> = {}): string => translator.t(key, params);

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
  vi.restoreAllMocks();
});

const deciding = (): Record<string, unknown> =>
  reviewDetail({
    stages: [
      {
        index: 0,
        id: 'technical',
        name: 'Thẩm định kỹ thuật',
        min_approvals: 2,
        approvals: 1,
        state: 'CURRENT',
        reviewers: [
          reviewer(1, { state: 'APPROVED', decision: 'approve', decided_at: '2026-11-03T02:00:00.000Z' }),
          reviewer(2, { can_decide: true, task_version: 4 }),
          reviewer(3, { state: 'NOT_NEEDED' }),
        ],
      },
      { index: 1, id: 'legal', name: 'Thẩm định pháp lý', min_approvals: 1, approvals: 0, state: 'WAITING', reviewers: [] },
    ],
  });

function open(over: Partial<World> = {}, options: Parameters<typeof mountScreen>[2] = {}, command?: (operation: string, input: unknown) => unknown) {
  const h = client(world({ reviews: [reviewItem(1), reviewItem(2, { status: 'APPROVED', current_stage: null, concluded_at: '2026-11-03T04:00:00.000Z' })], review: deciding(), ...over }), command);
  const view = mountScreen(<ReviewBoardScreen route={route('DOC-26')} />, h, options);
  return { h, ...view };
}

describe('ReviewBoardScreen (DOC-26): the reviews of the documents and the board of one round', () => {
  it('UI-DOC-26: lists the rounds with the stage each waits at and filters them by status', async () => {
    const { h } = open();
    const table = await screen.findByTestId('reviews');
    expect(within(table).getAllByRole('row').slice(1)).toHaveLength(2);
    expect(table.textContent).toContain('Thẩm định kỹ thuật');
    expect(table.querySelector('a[data-open]')?.getAttribute('href')).toContain('/doc/doc-26?review=');
    fireEvent.change(screen.getAllByRole('combobox')[0] as HTMLSelectElement, { target: { value: 'APPROVED' } });
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('listDocumentReviews', expect.objectContaining({ query: expect.objectContaining({ status: 'APPROVED' }) })));
  });

  it('says an empty list, the scope hidden without the read right, and a service error with retry', async () => {
    open({ reviews: [] });
    expect(await screen.findByTestId('empty')).toBeTruthy();
    cleanup();
    const denied = open({}, { permissions: [] });
    expect(await screen.findByTestId('no-read')).toBeTruthy();
    expect(denied.h.read).not.toHaveBeenCalledWith('listDocumentReviews', expect.anything());
    cleanup();
    open({ failing: new Map([['listDocumentReviews', { error: problem('INTERNAL_ERROR', 500), times: 1 }]]) });
    fireEvent.click(await screen.findByRole('button', { name: /th.+l.i|retry/i }));
    await screen.findByTestId('reviews');
  });

  it('shows a skeleton while loading, never the number zero', async () => {
    open({ hanging: new Set(['listDocumentReviews']) });
    expect((await screen.findByRole('status', { busy: true })).textContent ?? '').not.toMatch(/\b0\b/);
  });

  it('shows the board: the stages with the number of approvals they need, the parallel reviewers with what each decided, and the history', async () => {
    open({}, { path: `/?review=${REVIEW}` });
    const stages = await screen.findByTestId('stages');
    expect(within(stages).getByTestId('approvals-technical').textContent).toContain('1');
    const tasks = stages.querySelectorAll('tr[data-task]');
    expect(Array.from(tasks).map((row) => row.getAttribute('data-state'))).toEqual(['APPROVED', 'PENDING', 'NOT_NEEDED']);
    expect(screen.getByTestId('events').querySelectorAll('[data-event]')).toHaveLength(1);
    expect(screen.getByTestId('document-link').getAttribute('href')).toContain(`/doc/doc-25?id=${DOCUMENT}&version=${VERSION_1}`);
    expect(screen.getByTestId('open-comments').textContent).toContain('2');
    // Only the reviewer the task is given to has the buttons; the others see the state only.
    expect(stages.querySelectorAll('[data-decide]')).toHaveLength(3);
  });

  it('approves with an optional note, at the version of the task the caller read', async () => {
    const { h } = open({}, { path: `/?review=${REVIEW}` });
    await screen.findByTestId('stages');
    fireEvent.click(document.querySelector('[data-decide="approve"]') as HTMLElement);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getAllByRole('button').find((button) => button.textContent === t('doc.repo.board.approve')) as HTMLElement);
    await screen.findByTestId('receipt');
    expect(h.command).toHaveBeenCalledWith('decideApprovalTask', expect.objectContaining({ ifMatchVersion: 4, body: { decision: 'approve' }, path: { taskId: uuid(11, 2) } }));
  });

  it('asks a reason of ten characters for a supplement request and for a rejection, and says a conflict with a way to read again', async () => {
    const command = vi.fn((operation: string) => (command.mock.calls.length === 1 ? problem('VERSION_CONFLICT', 409) : { operation_id: 'o', status: 'RETURNED', resource_version: 5, resource_id: uuid(11, 2) }));
    const { h } = open({}, { path: `/?review=${REVIEW}` }, command);
    await screen.findByTestId('stages');
    fireEvent.click(document.querySelector('[data-decide="return"]') as HTMLElement);
    const dialog = await screen.findByRole('dialog');
    const button = within(dialog).getAllByRole('button').find((item) => item.textContent === t('doc.repo.board.return')) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Thiếu căn cứ pháp lý của đơn giá' } });
    fireEvent.click(button);
    await within(dialog).findByTestId('reload');
    expect(h.command).toHaveBeenCalledWith('decideApprovalTask', expect.objectContaining({ body: { decision: 'return', reason: 'Thiếu căn cứ pháp lý của đơn giá' } }));
    fireEvent.click(within(dialog).getByTestId('reload'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('shows the conclusion of a round that asked for a supplement, and the way to send the next version', async () => {
    const review = reviewDetail(
      { review: round(1, { status: 'SUPPLEMENT_REQUESTED', conclusion_note: 'Thiếu căn cứ pháp lý' }), outcome: 'RETURNED' },
      { resubmit: true },
    );
    open({ review }, { path: `/?review=${REVIEW}` });
    expect((await screen.findByTestId('conclusion')).textContent).toContain('Thiếu căn cứ pháp lý');
    expect(screen.getByTestId('resubmit').getAttribute('href')).toContain(`/doc/doc-25?id=${DOCUMENT}`);
  });

  it('withdraws an open round with a reason, only for who the server allows', async () => {
    const { h } = open({ review: reviewDetail({}, { withdraw: true }) }, { path: `/?review=${REVIEW}` });
    fireEvent.click(await screen.findByTestId('withdraw'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Gửi nhầm hồ sơ, sẽ trình lại' } });
    fireEvent.click(within(dialog).getAllByRole('button').find((button) => button.textContent === t('doc.repo.withdraw.confirm')) as HTMLElement);
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('withdrawDocumentReview', expect.objectContaining({ body: { reason: 'Gửi nhầm hồ sơ, sẽ trình lại' } })));
    cleanup();
    open({}, { path: `/?review=${REVIEW}` });
    await screen.findByTestId('stages');
    expect(screen.queryByTestId('withdraw')).toBeNull();
  });

  it('says a round whose workflow has no stages, hides the buttons in a read-only session, and marks a stale board', async () => {
    open({ review: reviewDetail({ stages: [] }) }, { path: `/?review=${REVIEW}` });
    expect(await screen.findByTestId('no-stages')).toBeTruthy();
    cleanup();
    open({}, { path: `/?review=${REVIEW}`, mode: 'READ_ONLY' });
    await screen.findByTestId('stages');
    expect(document.querySelectorAll('[data-decide]')).toHaveLength(0);
    expect(screen.getByTestId('readonly-note')).toBeTruthy();
    cleanup();
    const failing = new Map([['getDocumentReview', { error: problem('INTERNAL_ERROR', 500), times: 0 }]]);
    const { queries, h } = open({ failing }, { path: `/?review=${REVIEW}` });
    await screen.findByTestId('stages');
    failing.set('getDocumentReview', { error: problem('INTERNAL_ERROR', 500), times: 5 });
    await queries.invalidateQueries();
    await screen.findByTestId('stale-note');
    expect(h.read).toHaveBeenCalledWith('getDocumentReview', expect.anything());
  });

  it('starts over when the membership changes', async () => {
    const { switchTo, h } = open({}, { path: `/?review=${REVIEW}` });
    await screen.findByTestId('stages');
    const before = h.read.mock.calls.filter(([operation]) => operation === 'getDocumentReview').length;
    switchTo();
    await waitFor(() => expect(h.read.mock.calls.filter(([operation]) => operation === 'getDocumentReview').length).toBeGreaterThan(before));
  });
});
