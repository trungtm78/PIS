import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { harness, mountInSession } from '../../doc/test-support';
import type { Harness } from '../../doc/test-support';
import { routeOf as baseRoute } from '../../sas/test-support';
import { classificationLabel, typeLabel } from './labels';
import SearchScreen from './SearchScreen';
import { MAX_QUERY_LENGTH, PAGE_SIZE, ofType, openPath, queryProblem, toHit, toSearchPage, typesOf } from './model';

const word = (key: string): string => (vi_ as Record<string, string>)[key] ?? key;
const ROUTE = { ...baseRoute('IAM-07', 'FR-IAM-07'), module: 'IAM', path: '/iam/iam-07' };
const ID = (n: number): string => `00000000-0000-4000-8000-${'0507'}${String(n).padStart(8, '0')}`;
const hit = (n: number, extra: Record<string, unknown> = {}) => ({ entity_type: 'project', entity_id: ID(n), title: `Dự án ${n}`, classification: 'INTERNAL', snippet: `đoạn trích ${n}`, ...extra });

interface World {
  pages: Array<{ items: unknown[]; next_cursor: string | null }>;
  failure: Error | undefined;
}

function open(world: Partial<World> = {}, options: { permissions?: readonly string[] | undefined; path?: string } = {}): Harness & { state: World } {
  const state: World = { pages: [{ items: [hit(1), hit(2, { entity_type: 'issue' })], next_cursor: null }], failure: undefined, ...world };
  const h = harness((operation, input) => {
    if (operation !== 'searchGlobal') return new Error(`unexpected read ${operation}`);
    if (state.failure !== undefined) return state.failure;
    const cursor = (input as { query: { cursor?: string } }).query.cursor;
    return state.pages[cursor === undefined ? 0 : Number(cursor)] ?? { items: [], next_cursor: null };
  });
  mountInSession(<SearchScreen route={ROUTE} />, h, { permissions: 'permissions' in options ? options.permissions : ['search.use'] }, options.path ?? '/iam/iam-07');
  return Object.assign(h, { state });
}

const reads = (h: Harness): Array<{ q: string; limit: number; cursor?: string }> => h.read.mock.calls.map((call) => (call[1] as { query: { q: string; limit: number; cursor?: string } }).query);
const type = (value: string): void => {
  fireEvent.change(screen.getByLabelText(word('iam.search.query.label')), { target: { value } });
};
const submit = (): void => {
  fireEvent.click(screen.getByRole('button', { name: word('iam.search.submit.action') }));
};

afterEach(() => cleanup());

describe('the model of the search (ST-IAM-008)', () => {
  it('reads a hit with the classification it carries and drops what is not one', () => {
    expect(toHit(hit(1))).toEqual({ entityType: 'project', entityId: ID(1), title: 'Dự án 1', classification: 'INTERNAL', snippet: 'đoạn trích 1' });
    expect(toHit(hit(1, { title: null, snippet: null, classification: 'PERSONAL' }))).toMatchObject({ title: null, snippet: null, classification: 'PERSONAL' });
    expect(toHit(hit(1, { classification: 'SECRET' }))).toBeUndefined();
    expect(toHit(hit(1, { entity_type: '' }))).toBeUndefined();
    expect(toHit(hit(1, { entity_id: 3 }))).toBeUndefined();
    expect(toHit('x')).toBeUndefined();
    expect(toHit([])).toBeUndefined();
  });

  it('reads a page with its cursor, and an answer that is not a page as an empty one', () => {
    expect(toSearchPage({ items: [hit(1), { nope: 1 }], next_cursor: 'abc' })).toMatchObject({ items: [{ entityId: ID(1) }], nextCursor: 'abc' });
    expect(toSearchPage({ items: [], next_cursor: '' }).nextCursor).toBeUndefined();
    expect(toSearchPage({ items: 3 })).toEqual({ items: [], nextCursor: undefined });
    expect(toSearchPage(null)).toEqual({ items: [], nextCursor: undefined });
  });

  it('counts the keyword in characters, not in UTF-16 units', () => {
    expect(queryProblem('a')).toBe('short');
    expect(queryProblem('  a  ')).toBe('short');
    expect(queryProblem('ab')).toBeUndefined();
    expect(queryProblem('😀')).toBe('short');
    expect(queryProblem('😀😀')).toBeUndefined();
    expect(queryProblem('x'.repeat(MAX_QUERY_LENGTH))).toBeUndefined();
    expect(queryProblem('x'.repeat(MAX_QUERY_LENGTH + 1))).toBe('long');
  });

  it('opens only the kinds of record whose screen takes an id', () => {
    expect(openPath({ entityType: 'project', entityId: ID(1) })).toBe(`/prj/prj-03?id=${ID(1)}`);
    expect(openPath({ entityType: 'issue', entityId: ID(1) })).toBe(`/iss/iss-03?id=${ID(1)}`);
    expect(openPath({ entityType: 'conversation', entityId: ID(1) })).toBe(`/omni/omni-02?id=${ID(1)}`);
    expect(openPath({ entityType: 'contract', entityId: ID(1) })).toBeUndefined();
  });

  it('lists the kinds among the hits and narrows to one', () => {
    const hits = [toHit(hit(1)), toHit(hit(2, { entity_type: 'issue' })), toHit(hit(3))].flatMap((entry) => entry ?? []);
    expect(typesOf(hits)).toEqual(['project', 'issue']);
    expect(ofType(hits, '')).toHaveLength(3);
    expect(ofType(hits, 'project')).toHaveLength(2);
  });

  it('names the kinds it knows and the classifications, and shows another kind by its own identifier', () => {
    const t = (key: string): string => word(key);
    expect(typeLabel(t, 'project')).toBe(word('iam.search.type.project'));
    expect(typeLabel(t, 'issue')).toBe(word('iam.search.type.issue'));
    expect(typeLabel(t, 'conversation')).toBe(word('iam.search.type.conversation'));
    expect(typeLabel(t, 'contract')).toBe('contract');
    expect(classificationLabel(t, 'PUBLIC')).toBe(word('iam.search.class.public'));
    expect(classificationLabel(t, 'INTERNAL')).toBe(word('iam.search.class.internal'));
    expect(classificationLabel(t, 'CONFIDENTIAL')).toBe(word('iam.search.class.confidential'));
    expect(classificationLabel(t, 'PERSONAL')).toBe(word('iam.search.class.personal'));
  });
});

describe('IAM-07: global search (ST-IAM-008, UI-IAM-07)', () => {
  it('labels its controls, names the fields of the screen and reads nothing before a keyword is sent', () => {
    const h = open();
    expect(screen.getByRole('search', { name: word('iam.search.form.aria') })).toBeTruthy();
    expect(screen.getByLabelText(word('iam.search.query.label'))).toBeTruthy();
    expect(screen.getByLabelText(word('iam.search.type.label'))).toBeTruthy();
    expect(screen.getByTestId('search-scope').textContent).toBe(word('iam.search.scope.note'));
    expect(screen.getByTestId('search-pick').textContent).toBe(word('iam.search.pick.notice'));
    expect(h.read).not.toHaveBeenCalled();
    expect(screen.getByText(`IAM-07 / FR-IAM-07 · ${word('iam.search.footer').split('· ')[1]}`)).toBeTruthy();
  });

  it('searches what was typed, keeps it in the address and shows the hits by permission with no total', async () => {
    const h = open();
    type('  dự án  ');
    submit();
    const results = await screen.findByTestId('search-results');
    expect(reads(h)).toEqual([{ q: 'dự án', limit: PAGE_SIZE }]);
    const items = within(results).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(
      within(items[0] as HTMLElement)
        .getByRole('link', { name: 'Dự án 1' })
        .getAttribute('href'),
    ).toBe(`/prj/prj-03?id=${ID(1)}`);
    expect(items[0]?.textContent).toContain(word('iam.search.class.internal'));
    expect(items[0]?.textContent).toContain('đoạn trích 1');
    expect(screen.getByTestId('search-nototal').textContent).toBe(word('iam.search.nototal.note'));
    // No number anywhere on the results: not a total, not a count of the hits shown.
    expect(results.textContent?.replace(/Dự án \d|đoạn trích \d/g, '')).not.toMatch(/\d/);
    expect(screen.queryByRole('button', { name: word('iam.search.more.action') })).toBeNull();
  });

  it('runs the keyword of the address on opening, so back and a shared link keep the search', async () => {
    const h = open({}, { path: '/iam/iam-07?q=cầu' });
    await screen.findByTestId('search-results');
    expect(reads(h)).toEqual([{ q: 'cầu', limit: PAGE_SIZE }]);
    expect((screen.getByLabelText(word('iam.search.query.label')) as HTMLInputElement).value).toBe('cầu');
  });

  it('shows a record that is not linked as plain text, a personal one without its name, and no snippet above internal', async () => {
    open(
      {
        pages: [
          {
            items: [
              hit(1, { entity_type: 'contract', title: 'Hợp đồng A' }),
              hit(2, { title: null, snippet: null, classification: 'PERSONAL' }),
              hit(3, { classification: 'CONFIDENTIAL', snippet: null }),
            ],
            next_cursor: null,
          },
        ],
      },
      { path: '/iam/iam-07?q=hợp' },
    );
    const results = await screen.findByTestId('search-results');
    expect(within(results).queryByRole('link', { name: 'Hợp đồng A' })).toBeNull();
    expect(within(results).getByText('Hợp đồng A')).toBeTruthy();
    expect(within(results).getByRole('link', { name: word('iam.search.hidden.title') })).toBeTruthy();
    expect(within(results).getAllByRole('listitem')[2]?.textContent).not.toContain('đoạn trích');
  });

  it('narrows the hits to a kind of record among those found', async () => {
    open({}, { path: '/iam/iam-07?q=dự' });
    await screen.findByTestId('search-results');
    const kinds = screen.getByLabelText(word('iam.search.type.label'));
    expect(
      within(kinds)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual([word('iam.search.type.all'), word('iam.search.type.project'), word('iam.search.type.issue')]);
    fireEvent.change(kinds, { target: { value: 'issue' } });
    expect(within(screen.getByTestId('search-results')).getAllByRole('listitem')).toHaveLength(1);
    fireEvent.change(kinds, { target: { value: '' } });
    expect(within(screen.getByTestId('search-results')).getAllByRole('listitem')).toHaveLength(2);
  });

  it('drops the kind chosen when a new keyword is searched', async () => {
    open({}, { path: '/iam/iam-07?q=dự' });
    await screen.findByTestId('search-results');
    fireEvent.change(screen.getByLabelText(word('iam.search.type.label')), { target: { value: 'issue' } });
    type('khác');
    submit();
    await waitFor(() => expect((screen.getByLabelText(word('iam.search.type.label')) as HTMLSelectElement).value).toBe(''));
  });

  it('loads the next page on request and keeps the cursor the API gave', async () => {
    const h = open(
      {
        pages: [
          { items: [hit(1)], next_cursor: '1' },
          { items: [hit(2)], next_cursor: null },
        ],
      },
      { path: '/iam/iam-07?q=dự' },
    );
    await screen.findByTestId('search-results');
    fireEvent.click(screen.getByRole('button', { name: word('iam.search.more.action') }));
    await waitFor(() => expect(within(screen.getByTestId('search-results')).getAllByRole('listitem')).toHaveLength(2));
    expect(reads(h)[1]).toEqual({ q: 'dự', limit: PAGE_SIZE, cursor: '1' });
    expect(screen.queryByRole('button', { name: word('iam.search.more.action') })).toBeNull();
  });

  it('shows the empty state, with nothing to say about what exists outside the scope', async () => {
    open({ pages: [{ items: [], next_cursor: null }] }, { path: '/iam/iam-07?q=không-có' });
    await screen.findByText(word('states.empty.title'));
    expect(screen.queryByTestId('search-results')).toBeNull();
  });

  it('refuses a keyword that is too short or too long without asking the API', () => {
    const h = open();
    type('a');
    submit();
    expect(screen.getByRole('alert').textContent).toBe(word('iam.search.query.tooShort'));
    type('x'.repeat(MAX_QUERY_LENGTH + 1));
    expect(screen.getByRole('alert').textContent).toBe(word('iam.search.query.tooLong'));
    expect(h.read).not.toHaveBeenCalled();
    type('ab');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says so for an address with a keyword the API would refuse, and reads nothing for it', () => {
    const h = open({}, { path: '/iam/iam-07?q=a' });
    expect(screen.getByRole('alert').textContent).toBe(word('iam.search.query.tooShort'));
    expect(h.read).not.toHaveBeenCalled();
    expect(screen.queryByTestId('search-results')).toBeNull();
  });

  it('shows the denied state without reading when the member does not hold search.use', () => {
    const h = open({}, { permissions: ['project.read'], path: '/iam/iam-07?q=dự' });
    expect(screen.getByTestId('search-denied')).toBeTruthy();
    expect(screen.getByText(word('states.denied.title'))).toBeTruthy();
    expect(screen.queryByRole('search')).toBeNull();
    expect(h.read).not.toHaveBeenCalled();
  });

  it('searches when the permissions are not known; the API decides', async () => {
    open({}, { permissions: undefined, path: '/iam/iam-07?q=dự' });
    await screen.findByTestId('search-results');
  });

  it('shows the denied state when the API refuses the scope', async () => {
    open({ failure: new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c-1' }) }, { path: '/iam/iam-07?q=dự' });
    await screen.findByText(word('states.denied.title'));
  });

  it('shows the error state and reads again on retry', async () => {
    const h = open({ failure: new Error('down') }, { path: '/iam/iam-07?q=dự' });
    await screen.findByText(word('states.error.title'));
    expect(h.read).toHaveBeenCalledTimes(1);
    h.state.failure = undefined;
    fireEvent.click(screen.getByRole('button', { name: word('states.retry.action') }));
    await screen.findByTestId('search-results');
  });

  it('shows the loading state while the API answers', () => {
    const h = harness(() => new Promise(() => undefined) as unknown as Error);
    mountInSession(<SearchScreen route={{ ...ROUTE, req: null }} />, h, { permissions: ['search.use'] }, '/iam/iam-07?q=dự');
    expect(screen.getByRole('status', { name: word('states.loading.label') })).toBeTruthy();
  });
});
