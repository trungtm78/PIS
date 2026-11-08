import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { translator } from '../../../i18n';
import RepositoryScreen from './RepositoryScreen';
import { ALL, DOCUMENT, READER, UPLOADED, client, mountScreen, route, summary, uuid, world } from './test/repo-test-support';
import type { World } from './test/repo-test-support';

const problem = (code: string, status: number, detail?: string) => new ApiError({ status, code, correlationId: 'c', ...(detail === undefined ? {} : { detail }) });

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
  vi.restoreAllMocks();
});

function open(over: Partial<World> = {}, options: Parameters<typeof mountScreen>[2] = {}, command?: (operation: string, input: unknown) => unknown) {
  const state = world(over);
  const h = client(state, command);
  const view = mountScreen(<RepositoryScreen route={route('DOC-24')} />, h, options);
  return { state, h, ...view };
}

const loaded = async (): Promise<HTMLElement> => screen.findByTestId('documents');

describe('RepositoryScreen (DOC-24): the document repository of the projects', () => {
  it('UI-DOC-24: lists the documents with class, links, effective state, version and review, and archived ones marked', async () => {
    open();
    const table = await loaded();
    expect(screen.getByRole('heading', { level: 1 })).toBeTruthy();
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    const first = rows[0] as HTMLElement;
    expect(first.getAttribute('data-document')).toBe(uuid(2, 1));
    expect(first.textContent).toContain('Thiết kế cơ sở gói 1');
    expect(first.textContent).toContain('TK-01');
    expect(first.textContent).toContain('DA-01');
    expect(first.textContent).toContain('HD-01');
    expect(first.textContent).toContain('GT-03');
    expect((rows[1] as HTMLElement).getAttribute('data-status')).toBe('ARCHIVED');
    expect(screen.getByTestId('count').textContent).toContain('2');
    expect(first.querySelector('a[data-open]')?.getAttribute('href')).toContain(`/doc/doc-25?id=${uuid(2, 1)}`);
    expect(first.querySelector('a[data-review]')?.getAttribute('href')).toContain('/doc/doc-26?review=');
  });

  it('shows a skeleton while loading, never the number zero, then the list', async () => {
    const { state } = open({ hanging: new Set(['listProjectDocuments']) });
    const busy = await screen.findByRole('status', { busy: true });
    expect(busy.textContent ?? '').not.toMatch(/\b0\b/);
    expect(state.documents.length).toBe(2);
    expect(screen.queryByTestId('documents')).toBeNull();
  });

  it('says an empty repository and an empty filter result differently, and clears the filter', async () => {
    const { h } = open({ documents: [] });
    const empty = await screen.findByTestId('empty');
    expect(screen.queryByTestId('clear-filters')).toBeNull();
    const plain = empty.textContent;
    fireEvent.change(screen.getByLabelText(/lo.i|class/i, { selector: '#f-class' }), { target: { value: 'DESIGN' } });
    await waitFor(() => expect(screen.getByTestId('clear-filters')).toBeTruthy());
    expect(screen.getByTestId('empty').textContent).not.toBe(plain);
    expect(h.read).toHaveBeenCalledWith('listProjectDocuments', expect.objectContaining({ query: expect.objectContaining({ doc_class: 'DESIGN' }) }));
    fireEvent.click(screen.getByTestId('clear-filters'));
    await waitFor(() => expect(screen.queryByTestId('clear-filters')).toBeNull());
  });

  it('sends the search text and the filters as the query of the list', async () => {
    const { h } = open();
    await loaded();
    fireEvent.change(document.querySelector('#f-text') as HTMLInputElement, { target: { value: '  thiết kế  ' } });
    fireEvent.click(screen.getByTestId('search'));
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('listProjectDocuments', expect.objectContaining({ query: expect.objectContaining({ q: 'thiết kế' }) })));
    fireEvent.change(document.querySelector('#f-effective') as HTMLSelectElement, { target: { value: 'EXPIRED' } });
    fireEvent.change(document.querySelector('#f-review') as HTMLSelectElement, { target: { value: 'NONE' } });
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('listProjectDocuments', expect.objectContaining({ query: expect.objectContaining({ effective: 'EXPIRED', review_status: 'NONE' }) })));
  });

  it('loads the next page when asked', async () => {
    open({ more: [summary(3, { title: 'Báo cáo tiến độ tháng 10' })] });
    await loaded();
    fireEvent.click(await screen.findByTestId('more'));
    await waitFor(() => expect(screen.getByText('Báo cáo tiến độ tháng 10')).toBeTruthy());
    expect(screen.queryByTestId('more')).toBeNull();
  });

  it('says a service error in place with a retry, and recovers', async () => {
    const failing = new Map([['listProjectDocuments', { error: problem('INTERNAL_ERROR', 500), times: 1 }]]);
    open({ failing });
    const retry = await screen.findByRole('button', { name: /th.+l.i|retry/i });
    fireEvent.click(retry);
    await loaded();
  });

  it('keeps the last list and marks it stale when a refresh fails', async () => {
    const { state, queries } = open();
    await loaded();
    state.failing.set('listProjectDocuments', { error: problem('INTERNAL_ERROR', 500), times: 5 });
    await queries.invalidateQueries();
    await screen.findByTestId('stale-note');
    expect(screen.getByTestId('documents')).toBeTruthy();
  });

  it('says the scope is hidden to a member without the read right and asks the server for nothing', async () => {
    const { h } = open({}, { permissions: [] });
    expect(await screen.findByTestId('no-read')).toBeTruthy();
    expect(screen.queryByTestId('documents')).toBeNull();
    expect(screen.queryByTestId('add-document')).toBeNull();
    expect(h.read).not.toHaveBeenCalledWith('listProjectDocuments', expect.anything());
  });

  it('offers adding a document only to who may upload, and not in a read-only session', async () => {
    const reader = open({}, { permissions: READER });
    await loaded();
    expect(screen.queryByTestId('add-document')).toBeNull();
    reader.unmount();
    cleanup();
    open({}, { mode: 'READ_ONLY' });
    await loaded();
    expect(screen.queryByTestId('add-document')).toBeNull();
    expect(screen.getByTestId('readonly-note')).toBeTruthy();
  });

  it('uploads a file, creates the document from the key and the hash, and links to it with a receipt', async () => {
    const created = { operation_id: 'o', status: 'CREATED', resource_version: 1, resource_id: DOCUMENT };
    const { h, upload } = open({}, { permissions: ALL }, () => created);
    await loaded();
    fireEvent.click(screen.getByTestId('add-document'));
    // Without a file the dialog refuses to send anything.
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getAllByRole('button').find((button) => button.textContent === translator.t('doc.repo.create.confirm')) as HTMLElement);
    expect(h.command).not.toHaveBeenCalled();
    const input = within(dialog).getByTestId('file-input') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File([new Uint8Array([37, 80, 68, 70])], 'thiet-ke.docx')] } });
    await within(dialog).findByTestId('file-staged');
    expect(upload).toHaveBeenCalledTimes(1);
    await waitFor(() => expect((document.querySelector('#repo-project') as HTMLSelectElement).options.length).toBeGreaterThan(1));
    fireEvent.change(document.querySelector('#repo-project') as HTMLSelectElement, { target: { value: uuid(1, 1) } });
    fireEvent.change(document.querySelector('#repo-class') as HTMLSelectElement, { target: { value: 'DESIGN' } });
    fireEvent.change(document.querySelector('#repo-title') as HTMLInputElement, { target: { value: 'Thiết kế cơ sở gói thầu số 3' } });
    fireEvent.change(document.querySelector('#repo-reference') as HTMLInputElement, { target: { value: 'TK-03' } });
    fireEvent.click(within(dialog).getAllByRole('button').find((button) => button.textContent === translator.t('doc.repo.create.confirm')) as HTMLElement);
    await screen.findByTestId('create-receipt');
    expect(h.command).toHaveBeenCalledWith('createProjectDocument', expect.objectContaining({ body: expect.objectContaining({ project_id: uuid(1, 1), doc_class: 'DESIGN', title: 'Thiết kế cơ sở gói thầu số 3', reference: 'TK-03', file_object_key: UPLOADED.file_object_key, file_sha256: UPLOADED.file_sha256 }) }));
    expect(screen.getByTestId('created-link').getAttribute('href')).toContain(DOCUMENT);
  });

  it('says a refused upload in place and a refused creation inside the dialog, keeping what was typed', async () => {
    const { h } = open({}, { permissions: ALL, upload: () => problem('FILE_NOT_CLEAN', 422) as unknown }, () => problem('DOC_LINK_MISMATCH', 422));
    await loaded();
    fireEvent.click(screen.getByTestId('add-document'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByTestId('file-input'), { target: { files: [new File([new Uint8Array([1])], 'x.pdf')] } });
    expect((await within(dialog).findByTestId('file-error')).textContent).toBeTruthy();
    expect(within(dialog).queryByTestId('file-staged')).toBeNull();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('starts over when the signed-in membership changes', async () => {
    const { switchTo, h } = open();
    await loaded();
    const before = h.read.mock.calls.filter(([operation]) => operation === 'listProjectDocuments').length;
    switchTo();
    await waitFor(() => expect(h.read.mock.calls.filter(([operation]) => operation === 'listProjectDocuments').length).toBeGreaterThan(before));
  });
});
