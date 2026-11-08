import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { translator } from '../../../i18n';
import DocumentScreen from './DocumentScreen';
import { ALL, DOCUMENT, READER, VERSION_1, VERSION_2, citation, client, comment, detail, mountScreen, route, summary, unit, versionDetail, versionView, world } from './test/repo-test-support';
import type { World } from './test/repo-test-support';

const problem = (code: string, status: number, detail?: string) => new ApiError({ status, code, correlationId: 'c', ...(detail === undefined ? {} : { detail }) });
const t = (key: string, params: Record<string, string | number> = {}): string => translator.t(key, params);

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
  vi.restoreAllMocks();
});

function seed(over: Partial<World> = {}, actions: Record<string, unknown> = {}): World {
  return world({
    detail: detail({}, actions),
    versions: { [VERSION_2]: versionDetail(2), [VERSION_1]: versionDetail(1) },
    units: { [VERSION_2]: [unit(1), unit(2), unit(3, { text: '<img src=x onerror=alert(1)> giá trị' })], [VERSION_1]: [unit(1)] },
    comments: [comment(1), comment(2, { citation_id: null, citation_label: null, parent_id: null, status: 'RESOLVED', resolved_by: 'x', resolved_at: '2026-11-05T02:00:00.000Z', resolution_note: 'Đã sửa' })],
    ...over,
  });
}

function open(state: World, options: Parameters<typeof mountScreen>[2] = {}, command?: (operation: string, input: unknown) => unknown) {
  const h = client(state, command);
  const view = mountScreen(<DocumentScreen route={route('DOC-25')} />, h, { path: `/?id=${DOCUMENT}`, ...options });
  return { h, ...view };
}

const loaded = async (): Promise<void> => {
  await screen.findByTestId('facts');
  await screen.findByTestId('units');
};
const confirm = (dialog: HTMLElement, label: string): HTMLElement => within(dialog).getAllByRole('button').find((button) => button.textContent === label) as HTMLElement;

describe('DocumentScreen (DOC-25): a document, its versions, its text with citations and its comments', () => {
  it('UI-DOC-25: shows the description, the versions with their locks, the viewer with a reference per unit, the comments and the rounds', async () => {
    open(seed());
    await loaded();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Thiết kế cơ sở gói 1');
    expect(screen.getByTestId('fact-contract').textContent).toBe('HD-01');
    expect(screen.getByTestId('fact-package').textContent).toBe('GT-03');
    expect(screen.getByTestId('fact-period').textContent).toContain('2026');
    const versions = screen.getByTestId('versions');
    expect(versions.querySelectorAll('tr[data-version]')).toHaveLength(2);
    expect(within(versions).getByTestId(`locked-${VERSION_1}`).textContent).toContain('Phạm Thị Lan');
    expect(screen.getByTestId('to-compare').getAttribute('href')).toContain(`/doc/doc-27?id=${DOCUMENT}`);
    const refs = screen.getAllByTestId('reference').map((node) => node.textContent);
    expect(refs[0]).toBe(`docver:${VERSION_1}#${citation(1)}`);
    expect(screen.getByTestId('comments-count').textContent).toBeTruthy();
    expect(screen.getByTestId('rounds').querySelectorAll('[data-round]')).toHaveLength(1);
    // The text of a unit is text: markup in it is never turned into elements.
    expect(screen.getByTestId('units').querySelector('img')).toBeNull();
    expect(screen.getByTestId('units').textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('shows the lock banner on a locked version and offers no step that changes it', async () => {
    open(seed({ detail: detail({ document: summary(1, { current_version: { id: VERSION_1, version_no: 1, status: 'APPROVED', format: 'DOCX' } }) }, { submit_for_review: false }) }));
    await loaded();
    await waitFor(() => expect(screen.getByTestId('locked-banner')).toBeTruthy());
    expect(screen.queryByTestId('submit')).toBeNull();
  });

  it('shows a skeleton while loading, says the missing id, and a missing document as a service error with retry', async () => {
    const hanging = open(seed({ hanging: new Set(['getProjectDocument']) }));
    expect((await screen.findByRole('status', { busy: true })).textContent ?? '').not.toMatch(/\b0\b/);
    hanging.unmount();
    cleanup();
    mountScreen(<DocumentScreen route={route('DOC-25')} />, client(seed()), { path: '/' });
    expect(await screen.findByTestId('no-id')).toBeTruthy();
    cleanup();
    const failing = new Map([['getProjectDocument', { error: problem('RESOURCE_NOT_FOUND', 404), times: 1 }]]);
    open(seed({ failing }));
    fireEvent.click(await screen.findByRole('button', { name: /th.+l.i|retry/i }));
    await loaded();
  });

  it('says the scope is hidden without the read right, and marks the page stale when a refresh fails', async () => {
    const denied = open(seed(), { permissions: [] });
    expect(await screen.findByTestId('no-read')).toBeTruthy();
    expect(denied.h.read).not.toHaveBeenCalledWith('getProjectDocument', expect.anything());
    cleanup();
    const state = seed();
    const { queries } = open(state);
    await loaded();
    state.failing.set('getProjectDocument', { error: problem('INTERNAL_ERROR', 500), times: 5 });
    await queries.invalidateQueries();
    await screen.findByTestId('stale-note');
    expect(screen.getByTestId('facts')).toBeTruthy();
  });

  it('shows only the steps the server says the caller may take, and none in a read-only session', async () => {
    open(seed({}, { update: false, add_version: false, archive: false, submit_for_review: true }));
    await loaded();
    expect(screen.queryByTestId('edit')).toBeNull();
    expect(screen.queryByTestId('add-version')).toBeNull();
    expect(screen.queryByTestId('archive')).toBeNull();
    expect(screen.getByTestId('submit')).toBeTruthy();
    cleanup();
    open(seed(), { mode: 'READ_ONLY' });
    await loaded();
    expect(screen.queryByTestId('actions')).toBeNull();
    expect(screen.getByTestId('readonly-note')).toBeTruthy();
    cleanup();
    open(seed({ versions: { [VERSION_2]: versionDetail(2, {}, { comment: false, download: false }), [VERSION_1]: versionDetail(1) } }), { permissions: READER });
    await loaded();
    expect(screen.getByTestId('comment-denied')).toBeTruthy();
    expect((screen.getByTestId('download') as HTMLButtonElement).disabled).toBe(true);
  });

  it('archives with a reason of ten characters at the version read, and says a version conflict with a way to read again', async () => {
    const command = vi.fn((operation: string) => (operation === 'archiveProjectDocument' && command.mock.calls.length === 1 ? problem('VERSION_CONFLICT', 409) : { operation_id: 'o', status: 'ARCHIVED', resource_version: 4, resource_id: DOCUMENT }));
    const { h } = open(seed(), {}, command);
    await loaded();
    fireEvent.click(screen.getByTestId('archive'));
    const dialog = await screen.findByRole('dialog');
    const reason = within(dialog).getByRole('textbox');
    fireEvent.change(reason, { target: { value: 'ngắn' } });
    expect((confirm(dialog, t('doc.repo.archive.confirm')) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(reason, { target: { value: 'Thay bằng hồ sơ thiết kế mới' } });
    fireEvent.click(confirm(dialog, t('doc.repo.archive.confirm')));
    await within(dialog).findByTestId('reload');
    expect(h.command).toHaveBeenCalledWith('archiveProjectDocument', expect.objectContaining({ ifMatchVersion: 3, body: { reason: 'Thay bằng hồ sơ thiết kế mới' } }));
    fireEvent.click(within(dialog).getByTestId('reload'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByTestId('archive'));
    const again = await screen.findByRole('dialog');
    fireEvent.change(within(again).getByRole('textbox'), { target: { value: 'Thay bằng hồ sơ thiết kế mới' } });
    fireEvent.click(confirm(again, t('doc.repo.archive.confirm')));
    await screen.findByTestId('receipt');
  });

  it('restores an archived document and shows why it was archived', async () => {
    const archived = detail({ document: summary(1, { status: 'ARCHIVED', archive_reason: 'Thay bằng hồ sơ mới' }) }, { archive: false, restore: true, update: false, add_version: false, submit_for_review: false });
    const { h } = open(seed({ detail: archived }));
    await loaded();
    expect(screen.getByTestId('fact-archive').textContent).toBe('Thay bằng hồ sơ mới');
    fireEvent.click(screen.getByTestId('restore'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(confirm(dialog, t('doc.repo.restore.confirm')));
    await screen.findByTestId('receipt');
    expect(h.command).toHaveBeenCalledWith('restoreProjectDocument', expect.objectContaining({ ifMatchVersion: 3 }));
  });

  it('withdraws an open review with a reason', async () => {
    const open1 = detail({ rounds: [{ ...detail().rounds[0], status: 'IN_REVIEW', concluded_at: null }] }, { withdraw_review: true, archive: false, submit_for_review: false });
    const { h } = open(seed({ detail: open1 }));
    await loaded();
    fireEvent.click(screen.getByTestId('withdraw'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Gửi nhầm hồ sơ, sẽ trình lại' } });
    fireEvent.click(confirm(dialog, t('doc.repo.withdraw.confirm')));
    await screen.findByTestId('receipt');
    expect(h.command).toHaveBeenCalledWith('withdrawDocumentReview', expect.objectContaining({ body: { reason: 'Gửi nhầm hồ sơ, sẽ trình lại' } }));
  });

  it('anchors a comment to a unit, sends it with the citation, and shows the anchor until cleared', async () => {
    const { h } = open(seed());
    await loaded();
    fireEvent.click(document.querySelector(`[data-comments="${citation(2)}"]`) as HTMLElement);
    expect(await screen.findByTestId('anchor')).toBeTruthy();
    fireEvent.change(document.querySelector('#comment-body') as HTMLTextAreaElement, { target: { value: 'Cần ghi rõ giá đã gồm thuế' } });
    fireEvent.click(screen.getByTestId('send-comment'));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('addDocumentComment', expect.objectContaining({ body: expect.objectContaining({ citation_id: citation(2), body: 'Cần ghi rõ giá đã gồm thuế' }) })));
    fireEvent.click(document.querySelector(`[data-comments="${citation(2)}"]`) as HTMLElement);
    fireEvent.click(screen.getByTestId('clear-anchor'));
    expect(screen.queryByTestId('anchor')).toBeNull();
  });

  it('refuses a comment that is too short before it is sent, resolves one with a note, and reopens one', async () => {
    const { h } = open(seed());
    await loaded();
    fireEvent.change(document.querySelector('#comment-body') as HTMLTextAreaElement, { target: { value: 'a' } });
    fireEvent.click(screen.getByTestId('send-comment'));
    expect(await screen.findByTestId('comment-hint')).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.click(document.querySelector(`[data-resolve="${comment(1).id}"]`) as HTMLElement);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getAllByRole('button').filter((button) => (button as HTMLButtonElement).type === 'button' || true).find((button) => /xác|confirm|đánh dấu/i.test(button.textContent ?? '')) as HTMLElement);
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('resolveDocumentComment', expect.anything()));
    fireEvent.click(document.querySelector(`[data-reopen="${comment(2).id}"]`) as HTMLElement);
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('reopenDocumentComment', expect.objectContaining({ path: { id: comment(2).id } })));
  });

  it('says a version whose text could not be read, and reads it again for who may', async () => {
    const empty = versionDetail(2, { version: versionView(2, { extraction_status: 'NO_TEXT', unit_count: 0 }) }, { re_extract: true });
    const { h } = open(seed({ versions: { [VERSION_2]: empty, [VERSION_1]: versionDetail(1) }, units: { [VERSION_2]: [], [VERSION_1]: [] } }));
    await screen.findByTestId('no-text');
    fireEvent.click(screen.getByTestId('reextract'));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('rerunDocumentExtraction', expect.anything()));
  });

  it('asks for a download link and offers it as a link that is not the object key', async () => {
    open(seed());
    await loaded();
    fireEvent.click(screen.getByTestId('download'));
    const link = await screen.findByTestId('download-link');
    expect(link.getAttribute('href')).toContain('/project-document-files/');
    expect(link.getAttribute('href')).not.toContain('tenants/');
  });

  it('opens another version by the link of the table and starts over when the membership changes', async () => {
    const { h, switchTo } = open(seed());
    await loaded();
    fireEvent.click(document.querySelector(`[data-select="${VERSION_1}"]`) as HTMLElement);
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('getProjectDocumentVersion', expect.objectContaining({ path: { id: VERSION_1 } })));
    const before = h.read.mock.calls.filter(([operation]) => operation === 'getProjectDocument').length;
    switchTo();
    await waitFor(() => expect(h.read.mock.calls.filter(([operation]) => operation === 'getProjectDocument').length).toBeGreaterThan(before));
  });

  it('opens the dialogs to correct the description, add a version and send a draft to review', async () => {
    open(seed(), { permissions: ALL });
    await loaded();
    for (const id of ['edit', 'add-version', 'submit']) {
      fireEvent.click(screen.getByTestId(id));
      const dialog = await screen.findByRole('dialog');
      fireEvent.click(within(dialog).getAllByRole('button').find((button) => button.textContent === t('doc.repo.dialog.cancel')) as HTMLElement);
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    }
  });
});
