import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { mountInSession } from '../../doc/test-support';
import { routeOf } from '../../dgv/test-support';
import { harness as baseHarness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';
import KnowledgeScreen from './KnowledgeScreen';
import * as labels from './labels';
import { CLASSIFICATIONS, COLLECTION_STATUSES, EMPTY_COLLECTION, ITEM_STATUSES, collectionBody, describeProblem, toCollection, validateCollection, versionProblem } from './model';

const word = (key: string): string => (vi_ as Record<string, string>)[key] ?? key;
const fill = (value: string, values: Record<string, string | number>): string => Object.entries(values).reduce((out, [key, item]) => out.replace(`{${key}}`, String(item)), value);
const problem = (status: number, code: string, detail?: string) => new ApiError({ status, code, correlationId: 'c', detail, extensions: {} });
const uuid = (n: number): string => `00000000-0000-4000-8000-${'0160'}${String(n).padStart(8, '0')}`;
const ROUTE = routeOf('LLM-16', 'FR-LLM-16');
const MANAGE = ['llm.knowledge.read', 'llm.knowledge.manage'];
const READ = ['llm.knowledge.read'];

const item = (n: number, extra: Record<string, unknown> = {}) => ({
  id: uuid(200 + n),
  document_version_id: uuid(300 + n),
  chunk_count: 4,
  acl_hash: `${n}a`.repeat(32),
  status: 'INDEXED',
  classification: 'INTERNAL',
  failure_code: null,
  indexed_at: '2026-11-01T01:00:00Z',
  stale: false,
  version: 2,
  ...extra,
});
const collection = (n: number, extra: Record<string, unknown> = {}) => ({
  id: uuid(n),
  code: `KB-${n}`,
  title: `Hồ sơ thẩm định ${n}`,
  subject_module: 'PRJ',
  embedding_model_id: uuid(900),
  index_version: 1,
  max_classification: 'INTERNAL',
  status: 'ACTIVE',
  item_count: 0,
  created_at: '2026-11-01T01:00:00Z',
  version: 1,
  ...extra,
});

interface World {
  rows: Array<Record<string, unknown>>;
  failing: Error | undefined;
  loading: boolean;
}

function open(
  state: Partial<World> = {},
  options: { permissions?: readonly string[]; mode?: 'FULL' | 'READ_ONLY'; command?: (operation: string, input: unknown) => unknown } = {},
): Harness & { world: World } {
  const world: World = { rows: [], failing: undefined, loading: false, ...state };
  const h = baseHarness((operation, input) => {
    if (operation === 'getAiKnowledgeCollection') {
      const found = world.rows.find((row) => row.id === (input as { path: { id: string } }).path.id);
      return found === undefined ? problem(404, 'RESOURCE_NOT_FOUND') : found;
    }
    return new Error(`unexpected read ${operation}`);
  }, options.command);
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn((operation: string) => {
    if (operation !== 'listAiKnowledgeCollections') return Promise.reject(new Error(`unexpected readAll ${operation}`));
    if (world.loading) return new Promise(() => undefined);
    return world.failing === undefined ? Promise.resolve(world.rows) : Promise.reject(world.failing);
  });
  mountInSession(<KnowledgeScreen route={ROUTE} />, h, { permissions: options.permissions ?? MANAGE, ...(options.mode === undefined ? {} : { mode: options.mode }) }, '/llm/llm-16');
  return Object.assign(h, { world });
}

const commandsCalled = (h: Harness, operation: string): Array<{ path?: Record<string, string>; body?: Record<string, unknown> }> =>
  h.command.mock.calls.filter((call) => call[0] === operation).map((call) => call[1] as { path?: Record<string, string>; body?: Record<string, unknown> });
const type = (id: string, value: string): void => {
  fireEvent.change(document.getElementById(id) as HTMLElement, { target: { value } });
};
const detail = (): HTMLElement => screen.getByTestId('collection-detail');
const openCollection = async (n: number): Promise<void> => {
  fireEvent.click(await screen.findByRole('button', { name: fill(word('llm.knowledge.open.action'), { code: `KB-${n}` }) }));
  await within(await screen.findByTestId('collection-detail')).findByTestId('detail-status');
};

afterEach(() => cleanup());

describe('the model of the knowledge collections (ST-LLM-007)', () => {
  it('reads a collection with its items, and leaves out what is not one', () => {
    const read = toCollection(
      collection(1, {
        item_count: 2,
        items: [item(1), item(2, { stale: true, status: 'FAILED', failure_code: 'X', classification: null, indexed_at: null }), { id: 'x' }, item(3, { status: 'LOST' })],
      }),
    );
    expect(read).toMatchObject({ id: uuid(1), code: 'KB-1', subjectModule: 'PRJ', maxClassification: 'INTERNAL', status: 'ACTIVE', itemCount: 2, version: 1 });
    expect(read?.items.map((one) => [one.status, one.stale, one.classification, one.failureCode])).toEqual([
      ['INDEXED', false, 'INTERNAL', null],
      ['FAILED', true, null, 'X'],
    ]);
    expect(toCollection(collection(2, { items: 'x', item_count: 'x', index_version: undefined }))).toMatchObject({ items: [], itemCount: 0, indexVersion: 0 });
    for (const bad of [null, {}, collection(3, { status: 'LOST' }), collection(3, { max_classification: 'SECRET' }), collection(3, { version: '1' }), collection(3, { code: 3 })])
      expect(toCollection(bad)).toBeUndefined();
  });

  it('checks a collection and a document version, and builds what is sent', () => {
    expect(validateCollection(EMPTY_COLLECTION)).toEqual({ code: 'required', title: 'required', subjectModule: 'required', embeddingModelId: 'required' });
    expect(validateCollection({ code: '-x', title: 'x', subjectModule: 'prj', embeddingModelId: 'nope', maxClassification: 'INTERNAL' })).toEqual({
      code: 'invalid',
      title: 'invalid',
      subjectModule: 'invalid',
      embeddingModelId: 'invalid',
    });
    const good = { code: ' KB-PRJ ', title: ' Hồ sơ ', subjectModule: ' PRJ ', embeddingModelId: ` ${uuid(1).toUpperCase()} `, maxClassification: 'CONFIDENTIAL' as const };
    expect(validateCollection(good)).toEqual({});
    expect(collectionBody(good)).toEqual({ code: 'KB-PRJ', title: 'Hồ sơ', subject_module: 'PRJ', embedding_model_id: uuid(1), max_classification: 'CONFIDENTIAL' });
    expect(versionProblem(' ')).toBe('required');
    expect(versionProblem('nope')).toBe('invalid');
    expect(versionProblem(uuid(5))).toBeUndefined();
  });

  it('says what a refusal means, and has a word for everything it names', () => {
    const cases: Array<[string, string]> = [
      ['MODEL_NOT_APPROVED', 'model'],
      ['CLASSIFICATION_ABOVE_COLLECTION', 'classification'],
      ['SCAN_PENDING', 'scan'],
      ['FILE_NOT_CLEAN', 'infected'],
      ['STAGE_TRANSITION_DENIED', 'state'],
      ['DUPLICATE_KEY', 'duplicate'],
      ['SCOPE_DENIED', 'scope'],
      ['RESOURCE_NOT_FOUND', 'notFound'],
      ['VALIDATION_FAILED', 'validation'],
      ['OTHER', 'general'],
    ];
    for (const [code, reason] of cases) expect(describeProblem(problem(409, code, 'field'))).toEqual({ reason, detail: 'field' });
    expect(describeProblem(problem(409, 'SCOPE_DENIED'))).toEqual({ reason: 'scope', detail: '' });
    expect(describeProblem(new Error('x'))).toEqual({ reason: 'general', detail: '' });
    const t = (key: string, values?: Record<string, string | number>): string => (values === undefined ? key : `${key}:${Object.values(values).join(',')}`);
    for (const one of CLASSIFICATIONS) expect(labels.classificationLabel(t, one)).toMatch(/^llm\.knowledge\.class\./);
    for (const one of COLLECTION_STATUSES) expect(labels.collectionStatusLabel(t, one)).toMatch(/^llm\.knowledge\.status\./);
    for (const one of ITEM_STATUSES) expect(labels.itemStatusLabel(t, one)).toMatch(/^llm\.knowledge\.item\./);
    for (const [, reason] of cases) expect(labels.problemMessage(t, { reason: reason as never, detail: 'f' })).toMatch(/^llm\.knowledge\.problem\./);
  });
});

const states: Array<[string, Error, string]> = [
  ['denied', problem(403, 'SCOPE_DENIED'), word('states.denied.title')],
  ['offline', new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c', extensions: {} }), word('states.offline.title')],
  ['error', problem(500, 'INTERNAL_ERROR'), word('states.error.title')],
  ['signed out', problem(401, 'SESSION_EXPIRED'), word('states.signedOut.title')],
];

describe('KnowledgeScreen (LLM-16): the knowledge collections and what is indexed (ST-LLM-007, UI-LLM-16)', () => {
  it('UI-LLM-16: lists the collections with the module, the highest classification, the documents and the state', async () => {
    open({ rows: [collection(1, { item_count: 3 }), collection(2, { status: 'RETIRED', max_classification: 'CONFIDENTIAL' })] });
    const table = await screen.findByTestId('collections');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(word('llm.knowledge.title'));
    const row = (n: number) => table.querySelector(`[data-collection="${uuid(n)}"]`) as HTMLElement;
    expect(within(row(1)).getByTestId('status').textContent).toBe(word('llm.knowledge.status.active'));
    expect(within(row(2)).getByTestId('status').textContent).toBe(word('llm.knowledge.status.retired'));
    expect(row(1).textContent).toContain('KB-1');
    expect(row(1).textContent).toContain('PRJ');
    expect(row(1).textContent).toContain(word('llm.knowledge.class.internal'));
    expect(row(2).textContent).toContain(word('llm.knowledge.class.confidential'));
    expect(row(1).querySelectorAll('td')[4]?.textContent).toBe('3');
  });

  it('UI-LLM-16, UAT-AC467: opens a collection to its items: the hash of the access list, the chunks, the classification, and the ones whose list changed marked', async () => {
    open({ rows: [collection(1, { item_count: 2, items: [item(1), item(2, { stale: true })] })] });
    await openCollection(1);
    expect(within(detail()).getByTestId('detail-model').textContent).toBe(uuid(900));
    expect(within(detail()).getByTestId('detail-max').textContent).toBe(word('llm.knowledge.class.internal'));
    const rows = within(detail()).getByTestId('items').querySelectorAll('tbody tr');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.getAttribute('data-stale')).toBe('false');
    expect(rows[1]?.getAttribute('data-stale')).toBe('true');
    expect(within(rows[1] as HTMLElement).getByTestId('stale').textContent).toBe(word('llm.knowledge.item.stale'));
    expect(within(rows[0] as HTMLElement).queryByTestId('stale')).toBeNull();
    expect(within(rows[0] as HTMLElement).getByTestId('acl-hash').textContent).toBe(item(1).acl_hash.slice(0, 12));
    expect(
      within(rows[0] as HTMLElement)
        .getByTestId('acl-hash')
        .getAttribute('title'),
    ).toBe(item(1).acl_hash);
    expect(rows[0]?.textContent).toContain(word('llm.knowledge.item.indexed'));
    fireEvent.click(within(detail()).getByRole('button', { name: word('llm.knowledge.detail.close') }));
    expect(screen.queryByTestId('collection-detail')).toBeNull();
  });

  it('says there are no items, and shows an item that failed or was removed without a button to index it again', async () => {
    open({
      rows: [collection(1, { items: [] }), collection(2, { items: [item(1, { status: 'REMOVED', classification: null, indexed_at: null }), item(2, { status: 'FAILED', failure_code: 'X' })] })],
    });
    await openCollection(1);
    expect(within(detail()).getByTestId('no-items').textContent).toBe(word('llm.knowledge.detail.none'));
    cleanup();
    open({ rows: [collection(2, { items: [item(1, { status: 'REMOVED', classification: null, indexed_at: null }), item(2, { status: 'FAILED', failure_code: 'X' })] })] });
    await openCollection(2);
    const rows = within(detail()).getByTestId('items').querySelectorAll('tbody tr');
    expect(within(rows[0] as HTMLElement).queryByRole('button')).toBeNull();
    expect(within(rows[1] as HTMLElement).getByRole('button')).toBeTruthy();
  });

  it('creates a collection: checked first, then sent, and the refusal of the server (the model is not approved) is shown', async () => {
    const h = open({ rows: [] }, { command: () => Promise.reject(problem(422, 'MODEL_NOT_APPROVED')) });
    expect((await screen.findByTestId('no-collections')).textContent).toBe(word('llm.knowledge.none'));
    const form = screen.getByRole('form', { name: word('llm.knowledge.create.title') });
    fireEvent.click(within(form).getByRole('button', { name: word('llm.knowledge.create.submit') }));
    expect((await within(form).findAllByText(word('llm.knowledge.form.required'))).length).toBe(4);
    expect(h.command).not.toHaveBeenCalled();
    type('knowledge-code', '-x');
    type('knowledge-title', 'x');
    type('knowledge-module', 'prj');
    type('knowledge-model', 'nope');
    fireEvent.click(within(form).getByRole('button', { name: word('llm.knowledge.create.submit') }));
    for (const key of ['code.invalid', 'title.invalid', 'module.invalid', 'model.invalid']) expect(await within(form).findByText(word(`llm.knowledge.create.${key}`))).toBeTruthy();
    type('knowledge-code', 'KB-PRJ');
    type('knowledge-title', 'Hồ sơ thẩm định');
    type('knowledge-module', 'PRJ');
    type('knowledge-model', uuid(900));
    fireEvent.change(document.getElementById('knowledge-max') as HTMLElement, { target: { value: 'CONFIDENTIAL' } });
    fireEvent.click(within(form).getByRole('button', { name: word('llm.knowledge.create.submit') }));
    expect((await within(form).findByTestId('create-refusal')).getAttribute('data-reason')).toBe('model');
    expect(commandsCalled(h, 'createAiKnowledgeCollection')[0]?.body).toEqual({
      code: 'KB-PRJ',
      title: 'Hồ sơ thẩm định',
      subject_module: 'PRJ',
      embedding_model_id: uuid(900),
      max_classification: 'CONFIDENTIAL',
    });
  });

  it('creates a collection that the server accepts, and clears the form', async () => {
    const h = open({ rows: [] }, { command: () => ({ operation_id: 'o', status: 'ACTIVE', resource_version: 1, resource_id: uuid(7) }) });
    await screen.findByTestId('no-collections');
    type('knowledge-code', 'KB-PRJ');
    type('knowledge-title', 'Hồ sơ thẩm định');
    type('knowledge-module', 'PRJ');
    type('knowledge-model', uuid(900));
    fireEvent.click(screen.getByRole('button', { name: word('llm.knowledge.create.submit') }));
    expect((await screen.findByTestId('create-saved')).textContent).toBe(word('llm.knowledge.create.saved'));
    expect(commandsCalled(h, 'createAiKnowledgeCollection')).toHaveLength(1);
    expect((document.getElementById('knowledge-code') as HTMLInputElement).value).toBe('');
  });

  it('keeps what was typed for the next collection while one is being created, and clears the form when nothing was changed', async () => {
    let settle: () => void = () => undefined;
    const h = open({ rows: [] }, { command: () => new Promise((resolve) => (settle = () => resolve({ operation_id: 'o', status: 'ACTIVE', resource_version: 1, resource_id: uuid(7) }))) });
    await screen.findByTestId('no-collections');
    type('knowledge-code', 'KB-PRJ');
    type('knowledge-title', 'Hồ sơ thẩm định');
    type('knowledge-module', 'PRJ');
    type('knowledge-model', uuid(900));
    fireEvent.click(screen.getByRole('button', { name: word('llm.knowledge.create.submit') }));
    await waitFor(() => expect(commandsCalled(h, 'createAiKnowledgeCollection')).toHaveLength(1));
    type('knowledge-code', 'KB-NEXT');
    await act(async () => settle());
    await screen.findByTestId('create-saved');
    expect((document.getElementById('knowledge-code') as HTMLInputElement).value).toBe('KB-NEXT');
    expect((document.getElementById('knowledge-title') as HTMLInputElement).value).toBe('Hồ sơ thẩm định');
    expect(commandsCalled(h, 'createAiKnowledgeCollection')).toHaveLength(1);
  });

  it('keeps the version typed for the next document while one is being indexed, and clears the one that was indexed', async () => {
    let settle: () => void = () => undefined;
    const h = open(
      { rows: [collection(1, { items: [] })] },
      { command: () => new Promise((resolve) => (settle = () => resolve({ operation_id: 'o', status: 'INDEXED', resource_version: 1, resource_id: uuid(8) }))) },
    );
    await openCollection(1);
    const form = within(detail()).getByRole('form', { name: word('llm.knowledge.index.title') });
    type(`knowledge-version-${uuid(1)}`, uuid(555));
    fireEvent.click(within(form).getByRole('button', { name: word('llm.knowledge.index.submit') }));
    await waitFor(() => expect(commandsCalled(h, 'indexAiKnowledgeItem')).toHaveLength(1));
    type(`knowledge-version-${uuid(1)}`, uuid(556));
    await act(async () => settle());
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect((document.getElementById(`knowledge-version-${uuid(1)}`) as HTMLInputElement).value).toBe(uuid(556));
    fireEvent.click(within(form).getByRole('button', { name: word('llm.knowledge.index.submit') }));
    await waitFor(() => expect(commandsCalled(h, 'indexAiKnowledgeItem')).toHaveLength(2));
    await act(async () => settle());
    await waitFor(() => expect((document.getElementById(`knowledge-version-${uuid(1)}`) as HTMLInputElement).value).toBe(''));
  });

  it('indexes a document version: checked first, then sent, and a refusal (above the classification) is shown; an item is indexed again from its row', async () => {
    const h = open({ rows: [collection(1, { items: [item(1, { stale: true })] })] }, { command: () => Promise.reject(problem(422, 'CLASSIFICATION_ABOVE_COLLECTION')) });
    await openCollection(1);
    const form = within(detail()).getByRole('form', { name: word('llm.knowledge.index.title') });
    fireEvent.click(within(form).getByRole('button', { name: word('llm.knowledge.index.submit') }));
    expect(await within(form).findByText(word('llm.knowledge.form.required'))).toBeTruthy();
    type(`knowledge-version-${uuid(1)}`, 'nope');
    fireEvent.click(within(form).getByRole('button', { name: word('llm.knowledge.index.submit') }));
    expect(await within(form).findByText(word('llm.knowledge.index.version.invalid'))).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    type(`knowledge-version-${uuid(1)}`, uuid(555).toUpperCase());
    fireEvent.click(within(form).getByRole('button', { name: word('llm.knowledge.index.submit') }));
    expect((await within(form).findByTestId('index-refusal')).getAttribute('data-reason')).toBe('classification');
    expect(commandsCalled(h, 'indexAiKnowledgeItem')[0]).toMatchObject({ path: { id: uuid(1) }, body: { document_version_id: uuid(555) } });
    // The item whose list changed is indexed again by its own button.
    fireEvent.click(within(detail()).getByRole('button', { name: fill(word('llm.knowledge.item.reindex'), { version: uuid(301).slice(0, 12) }) }));
    await waitFor(() => expect(commandsCalled(h, 'indexAiKnowledgeItem')).toHaveLength(2));
    expect(commandsCalled(h, 'indexAiKnowledgeItem')[1]).toMatchObject({ body: { document_version_id: uuid(301) } });
  });

  it('gives no form and no button to who may not, and none for a collection that takes no more documents', async () => {
    open({ rows: [collection(1, { items: [item(1)] })] }, { permissions: READ });
    expect(await screen.findByTestId('collections')).toBeTruthy();
    expect(screen.queryByRole('form')).toBeNull();
    await openCollection(1);
    expect(within(detail()).queryByRole('form')).toBeNull();
    expect(within(detail()).queryByRole('button', { name: /Index/ })).toBeNull();
    cleanup();
    open({ rows: [collection(1, { items: [item(1)] })] }, { permissions: MANAGE, mode: 'READ_ONLY' });
    await openCollection(1);
    expect(screen.queryByRole('form')).toBeNull();
    cleanup();
    open({ rows: [collection(1, { status: 'RETIRED', items: [item(1)] })] });
    await openCollection(1);
    expect(within(detail()).queryByRole('form')).toBeNull();
    expect(within(detail()).queryByRole('button', { name: fill(word('llm.knowledge.item.reindex'), { version: uuid(301).slice(0, 12) }) })).toBeNull();
  });

  it.each(states)('UI-LLM-16 shows the %s state when the collections cannot be read', async (_name, answer, title) => {
    open({ failing: answer });
    expect(await screen.findByText(title)).toBeTruthy();
    expect(screen.queryByRole('form')).toBeNull();
  });

  it('UI-LLM-16 shows the loading state while the collections are read, and the error state when one cannot be opened', async () => {
    open({ loading: true });
    expect(await screen.findByRole('status', { name: word('states.loading.label') })).toBeTruthy();
    cleanup();
    const h = open({ rows: [collection(1)] });
    (h.client as unknown as { read: unknown }).read = vi.fn(() => Promise.reject(problem(500, 'INTERNAL_ERROR')));
    fireEvent.click(await screen.findByRole('button', { name: fill(word('llm.knowledge.open.action'), { code: 'KB-1' }) }));
    expect(await within(await screen.findByTestId('collection-detail')).findByText(word('states.error.title'))).toBeTruthy();
  });
});
