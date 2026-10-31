import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { MANAGER, READER, client, dataset, mount, routeOf, world } from '../test-support';
import type { Harness } from '../test-support';
import GlossaryScreen from './GlossaryScreen';
import { EMPTY_BIND, bindBody, describeBind, holds, toBindingList, toTermOption, validateBind } from './model';

const ROUTE = routeOf('DGV-02', 'FR-DGV-02');
const DATASET = dataset(1);
const TERM_R1 = '00000000-0000-4000-8000-0000000000a1';
const TERM_R2 = '00000000-0000-4000-8000-0000000000a2';
const OK = { operation_id: 'o', status: 'BOUND', resource_version: 1, resource_id: 'x', existing: false };

const binding = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-0000000000b${n}`,
  column_name: 'cumulative_amount',
  term: { id: TERM_R1, term_code: 'GIAI_NGAN_LUY_KE', term_vi: 'Giải ngân lũy kế', definition: 'The cumulative disbursement of a project', revision: 1, status: 'PUBLISHED' },
  bound_by: { membership_id: '00000000-0000-4000-8000-000000000001', display_name: 'Nguyễn Văn An' },
  bound_at: '2026-10-31T01:00:00.000000Z',
  deprecated: false,
  successor: null,
  replaced: false,
  ...overrides,
});
const answer = (items: unknown[], coverage = { bound: items.length, deprecated: 0, terms: items.length }) => ({ items, coverage });
const TERMS = [
  { id: TERM_R2, term_code: 'GIAI_NGAN_LUY_KE', term_vi: 'Giải ngân lũy kế', revision: 2, status: 'PUBLISHED' },
  { id: '00000000-0000-4000-8000-0000000000a3', term_code: 'OLD', term_vi: 'Cũ', revision: 1, status: 'DEPRECATED' },
  { id: 'x' },
];

afterEach(cleanup);

function open(items: unknown[], command: (operation: string, input: unknown) => unknown = () => OK, options: { coverage?: { bound: number; deprecated: number; terms: number }; terms?: unknown[]; failing?: Error } = {}): Harness {
  const h = client(world({ datasets: [DATASET] }), command);
  h.read.mockImplementation((operation: string) => {
    if (operation !== 'listDatasetGlossaryBindings') return Promise.reject(new Error(`unexpected read ${operation}`));
    return options.failing === undefined ? Promise.resolve(answer(items, options.coverage)) : Promise.reject(options.failing);
  });
  const readAll = (h.client as unknown as { readAll: ReturnType<typeof vi.fn> }).readAll;
  const base = readAll.getMockImplementation();
  readAll.mockImplementation((operation: string, input?: unknown) => (operation === 'listGlossaryTerms' ? Promise.resolve(options.terms ?? TERMS) : (base?.(operation, input) as Promise<unknown[]>)));
  return h;
}

const show = (h: Harness, permissions: readonly string[] = [...MANAGER, 'glossary.read'], dataset = true) => mount(<GlossaryScreen route={ROUTE} />, h, permissions, `/dgv/dgv-02${dataset ? `?id=${DATASET.id}` : ''}`);
const sent = (h: Harness) => h.command.mock.calls.map(([name, input]) => ({ name, ...(input as { path?: Record<string, string>; body?: Record<string, unknown> }) }));

describe('GlossaryScreen (DGV-02): the glossary bound to a dataset', () => {
  it('UI-DGV-02, UAT-AC490: lists the terms bound with their column, revision and who bound them, warns in words of a binding on a replaced revision and offers the one in force, with the coverage', async () => {
    const h = open([binding(1, { column_name: null }), binding(2, { deprecated: true, term: { id: TERM_R1, term_code: 'OLD_CODE', term_vi: 'Cũ', definition: 'An old definition of a term', revision: 1, status: 'DEPRECATED' }, successor: { id: TERM_R2, revision: 2 } })], undefined, { coverage: { bound: 2, deprecated: 1, terms: 2 } });
    show(h, READER);
    const table = await screen.findByTestId('bindings');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['dgv.glossary.page.title']);
    for (const key of ['dgv.glossary.col.term', 'dgv.glossary.col.column', 'dgv.glossary.col.status', 'dgv.glossary.col.bound'] as const) expect(within(table).getByRole('columnheader', { name: vi_[key] })).toBeTruthy();
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('GIAI_NGAN_LUY_KE');
    expect(rows[0]?.textContent).toContain(vi_['dgv.glossary.row.wholeDataset']);
    expect(rows[0]?.textContent).toContain(vi_['dgv.glossary.row.current']);
    expect(rows[0]?.textContent).toContain('Nguyễn Văn An');
    expect(within(rows[1] as HTMLElement).getByTestId('deprecated').textContent).toBe(vi_['dgv.glossary.row.deprecated']);
    expect(within(rows[1] as HTMLElement).getByTestId('deprecated-warning').textContent).toBe(vi_['dgv.glossary.row.successor'].replace('{revision}', '2'));
    const coverage = screen.getByTestId('coverage');
    expect([...coverage.querySelectorAll('[data-figure]')].map((figure) => [figure.getAttribute('data-figure'), figure.querySelector('dd')?.textContent])).toEqual([['bound', '2'], ['terms', '2'], ['deprecated', '1']]);
    // A reader sees the warning but binds nothing.
    expect(screen.queryByRole('form', { name: vi_['dgv.glossary.form.title'] })).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['dgv.glossary.row.rebind.action'].replace('{revision}', '2') })).toBeNull();
  });

  it('binds the revision in force to the same column in one step from the warning', async () => {
    const h = open([binding(2, { deprecated: true, successor: { id: TERM_R2, revision: 2 }, term: { id: TERM_R1, term_code: 'GIAI_NGAN_LUY_KE', term_vi: 'x', definition: 'd', revision: 1, status: 'DEPRECATED' } })]);
    show(h);
    fireEvent.click(await screen.findByRole('button', { name: vi_['dgv.glossary.row.rebind.action'].replace('{revision}', '2') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(sent(h)[0]).toMatchObject({ name: 'bindGlossaryTermToDataset', path: { id: DATASET.id }, body: { glossary_term_id: TERM_R2, column_name: 'cumulative_amount' } });
  });

  it('refuses a binding that has no term or whose term is not an identifier before it asks, offers only the terms in force, and sends the term with its column', async () => {
    const h = open([]);
    show(h);
    const form = await screen.findByRole('form', { name: vi_['dgv.glossary.form.title'] });
    const select = (await within(form).findByLabelText(vi_['dgv.glossary.field.term.label'])) as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBeGreaterThan(1));
    expect(Array.from(select.options).map((option) => option.value)).toEqual(['', TERM_R2]);
    fireEvent.click(within(form).getByRole('button', { name: vi_['dgv.glossary.form.submit.action'] }));
    expect(await within(form).findByText(vi_['dgv.glossary.field.required.error'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(select, { target: { value: TERM_R2 } });
    fireEvent.change(within(form).getByLabelText(vi_['dgv.glossary.field.column.label']), { target: { value: ' cumulative_amount ' } });
    fireEvent.click(within(form).getByRole('button', { name: vi_['dgv.glossary.form.submit.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(sent(h)[0]?.body).toEqual({ glossary_term_id: TERM_R2, column_name: 'cumulative_amount' });
    expect((await screen.findByTestId('bind-saved')).textContent).toBe(vi_['dgv.glossary.form.saved']);
  });

  it('takes the identifier of the term when the caller may not read the glossary, and says in words why the server refused', async () => {
    const h = open([], () => new ApiError({ status: 422, code: 'GLOSSARY_TERM_NOT_PUBLISHED', correlationId: 'c' }));
    show(h, MANAGER);
    const form = await screen.findByRole('form', { name: vi_['dgv.glossary.form.title'] });
    expect(within(form).getByLabelText(vi_['dgv.glossary.field.term.label']).tagName).toBe('INPUT');
    fireEvent.change(within(form).getByLabelText(vi_['dgv.glossary.field.term.label']), { target: { value: 'not an identifier' } });
    fireEvent.click(within(form).getByRole('button', { name: vi_['dgv.glossary.form.submit.action'] }));
    expect(await within(form).findByText(vi_['dgv.glossary.field.invalid.error'])).toBeTruthy();
    fireEvent.change(within(form).getByLabelText(vi_['dgv.glossary.field.term.label']), { target: { value: TERM_R1 } });
    fireEvent.click(within(form).getByRole('button', { name: vi_['dgv.glossary.form.submit.action'] }));
    expect((await within(form).findByTestId('bind-refusal')).textContent).toBe(vi_['dgv.glossary.problem.notPublished']);
  });

  it('says in words that the rebinding was refused, asks for a dataset when none is named, and says when the bindings could not be read', async () => {
    const refused = open([binding(2, { deprecated: true, successor: { id: TERM_R2, revision: 2 } })], () => new ApiError({ status: 422, code: 'GLOSSARY_TERM_NOT_PUBLISHED', correlationId: 'c' }));
    show(refused);
    fireEvent.click(await screen.findByRole('button', { name: vi_['dgv.glossary.row.rebind.action'].replace('{revision}', '2') }));
    expect((await screen.findByTestId('successor-refusal')).textContent).toBe(vi_['dgv.glossary.problem.notPublished']);
    cleanup();
    show(open([]), MANAGER, false);
    expect((await screen.findByTestId('no-dataset')).textContent).toBe(vi_['dgv.glossary.noDataset.notice']);
    cleanup();
    const failing = open([], undefined, { failing: new ApiError({ status: 500, code: 'INTERNAL', correlationId: 'c' }) });
    show(failing);
    fireEvent.click(await screen.findByRole('button', { name: vi_['states.retry.action'] }));
    await waitFor(() => expect(failing.read.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('starts over with the dataset the address names, and leaves out the bindings that are history', async () => {
    const h = open([binding(1), binding(2, { replaced: true })]);
    show(h);
    const table = await screen.findByTestId('bindings');
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    const chooser = (await screen.findByLabelText(vi_['dgv.glossary.filter.dataset.label'])) as HTMLSelectElement;
    await waitFor(() => expect(Array.from(chooser.options).some((option) => option.value === DATASET.id)).toBe(true));
    expect(chooser.value).toBe(DATASET.id);
    fireEvent.change(chooser, { target: { value: '' } });
    expect(await screen.findByTestId('no-dataset')).toBeTruthy();
  });
});

describe('the model of the glossary bindings', () => {
  it('reads the bindings and the coverage and leaves out what is not one', () => {
    const read = toBindingList(answer([binding(1), { id: 'x' }, null, binding(2, { term: { id: TERM_R1, term_code: 'T', revision: 'x' } }), binding(3, { successor: { id: TERM_R2 }, bound_by: {}, column_name: 5 })], { bound: 3, deprecated: 'x' as never, terms: 2 }));
    expect(read.items.map((item) => item.id)).toEqual([binding(1).id, binding(3).id]);
    expect(read.items[1]).toMatchObject({ successor: null, boundBy: '', columnName: null });
    expect(read.coverage).toEqual({ bound: 3, deprecated: 0, terms: 2 });
    expect(toBindingList(undefined)).toEqual({ items: [], coverage: { bound: 0, deprecated: 0, terms: 0 } });
    expect(toBindingList({ items: [binding(1, { bound_by: { membership_id: 'm1' } })] }).items[0]?.boundBy).toBe('m1');
  });

  it('offers only the revisions in force as terms, and judges the form and the refusals', () => {
    expect(TERMS.flatMap(toTermOption)).toEqual([{ id: TERM_R2, termCode: 'GIAI_NGAN_LUY_KE', termVi: 'Giải ngân lũy kế', revision: 2 }]);
    expect(toTermOption({ id: TERM_R2, term_code: 'X', status: 'PUBLISHED', revision: 1 })[0]?.termVi).toBe('X');
    expect([holds(MANAGER, 'data.catalog.manage', undefined), holds(READER, 'data.catalog.manage', undefined), holds(undefined, 'x', 'FULL'), holds(MANAGER, 'data.catalog.manage', 'READ_ONLY')]).toEqual([true, false, true, false]);
    expect(validateBind(EMPTY_BIND)).toEqual({ termId: 'required' });
    expect(validateBind({ termId: 'x', columnName: 'y'.repeat(121) })).toEqual({ termId: 'invalid', columnName: 'invalid' });
    expect(validateBind({ termId: TERM_R1, columnName: '' })).toEqual({});
    expect(bindBody({ termId: ` ${TERM_R1} `, columnName: ' ' })).toEqual({ glossary_term_id: TERM_R1 });
    expect(bindBody({ termId: TERM_R1, columnName: ' amount ' })).toEqual({ glossary_term_id: TERM_R1, column_name: 'amount' });
    const refusal = (status: number, code: string) => describeBind(new ApiError({ status, code, correlationId: 'c' }));
    expect([refusal(422, 'GLOSSARY_TERM_NOT_PUBLISHED'), refusal(403, 'SCOPE_DENIED'), refusal(404, 'RESOURCE_NOT_FOUND'), refusal(422, 'VALIDATION_FAILED'), refusal(400, 'INVALID_REQUEST'), refusal(500, 'X'), describeBind(new Error('x'))]).toEqual([
      'notPublished', 'scopeDenied', 'notFound', 'validation', 'validation', 'general', 'general',
    ]);
  });
});
