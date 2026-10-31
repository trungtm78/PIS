import { ApiError } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import TemplateCompareScreen from './TemplateCompareScreen';
import { blockLines, defaultOther, diffLines, diffRequired, toRevisionDetail } from './templates/compare';
import { harness, mount, routeOf } from './test-support';

const ROUTE = routeOf('DOC-15', 'FR-DOC-15');
const READER = ['doc.template.read'];
const R1 = '00000000-0000-4000-8000-0000000000b1';
const R2 = '00000000-0000-4000-8000-0000000000b2';
const R3 = '00000000-0000-4000-8000-0000000000b3';

const revisions = [
  { id: R1, revision: 1, status: 'SUPERSEDED', confirmation_status: 'CONFIRMED', effective_from: '2026-01-01', effective_until: '2027-01-01' },
  { id: R2, revision: 2, status: 'PUBLISHED', confirmation_status: 'PENDING_CONFIRMATION', effective_from: '2027-01-01', effective_until: null },
  { id: R3, revision: 3, status: 'DRAFT', confirmation_status: 'PENDING_CONFIRMATION', effective_from: '2028-01-01', effective_until: null },
];

const detail = (id: string, revision: number, overrides: Record<string, unknown> = {}) => ({
  id,
  template_code: 'DOC-CV-GIAI-TRINH',
  revision,
  title: `Explanation letter r${revision}`,
  status: revisions[revision - 1]?.status,
  effective_from: revisions[revision - 1]?.effective_from,
  effective_until: revisions[revision - 1]?.effective_until,
  legal_basis: `Circular ${revision}/2026`,
  legal_confirmation_ref: revision === 1 ? 'CXN-10' : null,
  confirmation_status: revisions[revision - 1]?.confirmation_status,
  watermark_text: null,
  body_blocks: { blocks: [{ kind: 'heading', text: '{{title}}' }, { kind: 'paragraph', text: revision === 1 ? 'Dear {{recipient}}' : 'Respectfully {{recipient}}' }, ...(revision === 3 ? [{ kind: 'paragraph', text: '{{body}}' }] : [])] },
  placeholder_schema: { required: revision === 1 ? ['title', 'recipient'] : revision === 2 ? ['title', 'body'] : ['title', 'body', 'place'] },
  created_by_name: `Drafter ${revision}`,
  approved_by_name: revision === 3 ? null : `Approver ${revision}`,
  legal_confirmed_by_name: revision === 1 ? 'Lawyer' : null,
  revisions,
  ...overrides,
});

function open(failing = false) {
  return harness((operation, input) => {
    if (operation !== 'getDocumentTemplate') return new Error(`unexpected read ${operation}`);
    if (failing) return new ApiError({ status: 503, code: 'UNAVAILABLE', correlationId: 'c' });
    const id = (input as { path: { id: string } }).path.id;
    const at = revisions.findIndex((revision) => revision.id === id);
    return at < 0 ? new ApiError({ status: 404, code: 'RESOURCE_NOT_FOUND', correlationId: 'c' }) : detail(id, at + 1);
  });
}

afterEach(cleanup);

describe('TemplateCompareScreen (DOC-15)', () => {
  it('AC-ST-DOC-016-3: shows the content diff, the schema diff and the legal basis of both revisions with who drafted, published and confirmed each', async () => {
    mount(<TemplateCompareScreen route={ROUTE} />, open(), READER, `/doc/doc-15?id=${R2}`);
    const cards = await screen.findByTestId('revisions');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['doc.compare.page.title']);
    // The other revision defaults to the one before.
    const before = within(cards).getByText(vi_['doc.compare.revision.title'].replace('{code}', 'DOC-CV-GIAI-TRINH').replace('{revision}', '1'));
    expect(before.closest('[data-side]')?.getAttribute('data-side')).toBe('before');
    expect(screen.getByTestId('basis-before').textContent).toBe('Circular 1/2026');
    expect(screen.getByTestId('basis-after').textContent).toBe('Circular 2/2026');
    expect([screen.getByTestId('drafter-before').textContent, screen.getByTestId('approver-before').textContent, screen.getByTestId('confirmer-before').textContent]).toEqual(['Drafter 1', 'Approver 1', 'Lawyer']);
    expect([screen.getByTestId('drafter-after').textContent, screen.getByTestId('approver-after').textContent, screen.getByTestId('confirmer-after').textContent]).toEqual(['Drafter 2', 'Approver 2', '—']);
    expect(within(cards).getByText(vi_['doc.compare.revision.confirmed'].replace('{ref}', 'CXN-10'))).toBeTruthy();
    expect(within(cards).getByText(vi_['doc.compare.revision.pending'])).toBeTruthy();
    const content = within(screen.getByTestId('content-diff')).getAllByRole('listitem');
    expect(content.map((item) => [item.getAttribute('data-change'), item.textContent])).toEqual([
      ['same', `${vi_['doc.compare.diff.same']} heading: {{title}}`],
      ['removed', `${vi_['doc.compare.diff.removed']} paragraph: Dear {{recipient}}`],
      ['added', `${vi_['doc.compare.diff.added']} paragraph: Respectfully {{recipient}}`],
    ]);
    const schema = within(screen.getByTestId('schema-diff')).getAllByRole('listitem');
    expect(schema.map((item) => item.textContent)).toEqual([
      vi_['doc.compare.schema.added'].replace('{names}', 'body'),
      vi_['doc.compare.schema.removed'].replace('{names}', 'recipient'),
      vi_['doc.compare.schema.kept'].replace('{names}', 'title'),
    ]);
  });

  it('compares with the revision chosen from the list, which is kept in the address, and says when two contents are the same', async () => {
    mount(<TemplateCompareScreen route={ROUTE} />, open(), READER, `/doc/doc-15?id=${R3}&other=${R2}`);
    const content = await screen.findByTestId('content-diff');
    expect(within(content).getAllByRole('listitem').map((item) => item.getAttribute('data-change'))).toEqual(['same', 'same', 'added']);
    const user = userEvent.setup();
    const other = screen.getByLabelText(vi_['doc.compare.other.label']) as HTMLSelectElement;
    expect([...other.options].map((option) => option.value)).toEqual([R1, R2]);
    await user.selectOptions(other, R1);
    await waitFor(() => expect(screen.getByTestId('basis-before').textContent).toBe('Circular 1/2026'));
    expect(screen.getByTestId('basis-after').textContent).toBe('Circular 3/2026');
    expect(screen.getByTestId('approver-after').textContent).toBe('—');
  });

  it('says there is nothing to compare when the template has one revision, when none is chosen and when the reader may not read', async () => {
    const single = harness(() => ({ ...detail(R1, 1), revisions: [revisions[0]] }));
    mount(<TemplateCompareScreen route={ROUTE} />, single, READER, `/doc/doc-15?id=${R1}`);
    expect((await screen.findAllByText(vi_['doc.compare.none.revision'])).length).toBeGreaterThan(0);
    expect(screen.queryByTestId('content-diff')).toBeNull();
    expect(screen.queryByLabelText(vi_['doc.compare.other.label'])).toBeNull();
    cleanup();
    mount(<TemplateCompareScreen route={ROUTE} />, open(), READER, '/doc/doc-15');
    expect((await screen.findByTestId('no-template')).textContent).toContain(vi_['doc.compare.none.notice']);
    cleanup();
    mount(<TemplateCompareScreen route={ROUTE} />, open(), ['doc.render'], `/doc/doc-15?id=${R2}`);
    expect((await screen.findByTestId('no-read')).textContent).toBe(vi_['doc.compare.read.denied']);
  });

  it('shows the same content as the same, and reads again when the revisions could not be read', async () => {
    const same = harness((_operation, input) => detail((input as { path: { id: string } }).path.id, 1, { body_blocks: { blocks: [{ kind: 'paragraph', text: 'Same' }] }, revisions: [revisions[0], { ...revisions[0], id: R2, revision: 2 }] }));
    mount(<TemplateCompareScreen route={ROUTE} />, same, READER, `/doc/doc-15?id=${R2}`);
    expect((await screen.findByTestId('content-same')).textContent).toBe(vi_['doc.compare.content.same']);
    cleanup();
    mount(<TemplateCompareScreen route={ROUTE} />, open(true), READER, `/doc/doc-15?id=${R2}`);
    expect(await screen.findByRole('button', { name: vi_['states.retry.action'] })).toBeTruthy();
  });

});

describe('the comparison of revisions', () => {
  it('reads a revision with the people behind it, leaving out what is not a block or a name', () => {
    const odd = toRevisionDetail({ id: 'x', body_blocks: { blocks: [{ kind: 'p', text: 't' }, 5, null] }, placeholder_schema: { required: ['a', 3] }, revisions: [{ id: 'r', revision: 1, status: 'DRAFT' }, 7], created_by_name: 4 });
    expect(odd).toMatchObject({ blocks: [{ kind: 'p', text: 't' }], required: ['a'], revisions: [{ id: 'r', revision: 1, status: 'DRAFT' }], createdByName: null, confirmationStatus: 'PENDING_CONFIRMATION' });
    expect(toRevisionDetail(null)).toMatchObject({ id: '', blocks: [], required: [], revisions: [] });
    expect(toRevisionDetail({ confirmation_status: 'CONFIRMED' }).confirmationStatus).toBe('CONFIRMED');
    expect(blockLines([{ kind: 'heading', text: 'T' }])).toEqual(['heading: T']);
  });

  it('keeps the longest common run of lines and says what was removed and what was added', () => {
    expect(diffLines(['a', 'b', 'c'], ['a', 'c', 'd'])).toEqual([
      { change: 'same', text: 'a' },
      { change: 'removed', text: 'b' },
      { change: 'same', text: 'c' },
      { change: 'added', text: 'd' },
    ]);
    expect(diffLines([], ['x'])).toEqual([{ change: 'added', text: 'x' }]);
    expect(diffLines(['x'], [])).toEqual([{ change: 'removed', text: 'x' }]);
    expect(diffLines(['a', 'b'], ['b', 'a']).map((line) => line.change)).toEqual(['removed', 'same', 'added']);
    expect(diffLines([], [])).toEqual([]);
  });

  it('tells the placeholders a revision adds, drops and keeps', () => {
    expect(diffRequired(['a', 'b'], ['b', 'c'])).toEqual({ added: ['c'], removed: ['a'], kept: ['b'] });
  });

  it('picks the revision before as the other one, else the one after, else none', () => {
    const list = [
      { id: 'r2', revision: 2, status: 'PUBLISHED' },
      { id: 'r1', revision: 1, status: 'SUPERSEDED' },
      { id: 'r3', revision: 3, status: 'DRAFT' },
    ];
    expect(defaultOther(list, 'r3')).toBe('r2');
    expect(defaultOther(list, 'r1')).toBe('r2');
    expect(defaultOther([{ id: 'only', revision: 1, status: 'DRAFT' }], 'only')).toBeUndefined();
    expect(defaultOther(list, 'unknown')).toBeUndefined();
  });
});
