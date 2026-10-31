import { ApiError } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import LayoutProfilesScreen from './LayoutProfilesScreen';
import { EMPTY_FORM, boxOfForm, canPublish, describeProblem, formFrom, hasProblems, layoutBody, sealOverlapRatio, sealWithinRange, validateForm } from './layout/rules';
import { ELEMENTS, toProfile } from './layout/types';
import { harness, mount, mountInSession, routeOf } from './test-support';

const ROUTE = routeOf('DOC-16', 'FR-DOC-16');
const ME = '00000000-0000-4000-8000-000000000001'; // the member of the session of the test support
const OTHER = '00000000-0000-4000-8000-0000000000c2';
const MANAGER = ['doc.template.read', 'doc.layout.manage'];
const APPROVER = ['doc.template.read', 'doc.layout.approve'];
const READER = ['doc.template.read'];
const OK = { operation_id: 'o', status: 'DRAFT', resource_version: 1, resource_id: 'x' };

const STYLE = { sizePt: 13, bold: true, italic: false, uppercase: false };
const sizes: Record<string, number> = { nationalTitle: 13, motto: 14, agency: 13, number: 13, placeDate: 14, docTypeName: 14, summary: 14, body: 14, signerTitle: 14, signerName: 14, recipientsLabel: 12, recipientsList: 11, pageNumber: 14 };

const profile = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-0000000000a${n}`,
  profile_code: 'ND30_A4_STANDARD',
  revision: n,
  page_size: 'A4',
  margins_mm: { top: 20, bottom: 20, left: 30, right: 15 },
  font_family: 'Times New Roman',
  font_substitute: 'Tinos',
  element_styles: Object.fromEntries(ELEMENTS.map((name) => [name, { ...STYLE, sizePt: sizes[name] }])),
  signature_layout: { leaderBox: { xMm: 110, yMm: 215, widthMm: 70, heightMm: 40 }, sealBox: { xMm: 95, yMm: 225, widthMm: 40, heightMm: 40 } },
  number_field_layout: { number: { xMm: 30, yMm: 42, widthMm: 40, heightMm: 6 } },
  watermark_policy: { text: 'CHO XAC NHAN' },
  legal_basis: 'Nghi dinh 30/2020/ND-CP, Phu luc I',
  legal_confirmation_ref: null,
  confirmation_status: 'PENDING_CONFIRMATION',
  effective_from: '2026-01-01',
  effective_until: null,
  status: 'PUBLISHED',
  created_by: OTHER,
  approved_by: OTHER,
  version: 2,
  ...overrides,
});

/** The server as the screen sees it: `readAll` follows the cursors of the list, so the harness answers it with the rows. */
function open(items: unknown[] | Error | (() => unknown[] | Error), command: (operation: string, input: unknown) => unknown = () => OK) {
  const h = harness(() => new Error('unexpected read'), command);
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn((operation: string) => {
    const rows = typeof items === 'function' ? items() : items;
    if (operation !== 'listDocumentLayoutProfiles') return Promise.reject(new Error(`unexpected readAll ${operation}`));
    return rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows);
  });
  return h;
}

const page = (id = ROUTE.id) => id;
afterEach(cleanup);

describe('LayoutProfilesScreen (DOC-16)', () => {
  it('shows the ranges of Appendix I, and the revisions with their period, state and confirmation', async () => {
    mount(<LayoutProfilesScreen route={ROUTE} />, open([profile(1, { effective_until: '2027-01-01' }), profile(2, { status: 'DRAFT', effective_from: '2027-01-01', version: 1 })]), READER);
    const ranges = await screen.findByTestId('ranges');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['doc.layout.page.title']);
    expect(within(ranges).getByText(vi_['doc.layout.margin.top'])).toBeTruthy();
    expect(within(ranges).getAllByText(vi_['doc.layout.ranges.mm'].replace('{range}', '20–25'))).toHaveLength(2);
    expect(within(ranges).getAllByText(vi_['doc.layout.ranges.pt'].replace('{range}', '12–13'))).toHaveLength(2);
    expect(within(ranges).getByText(vi_['doc.layout.ranges.pt'].replace('{range}', '11'))).toBeTruthy();
    expect(within(ranges).getByText(vi_['doc.layout.ranges.seal.allowed'].replace('{target}', '33.3').replace('{tolerance}', '3'))).toBeTruthy();
    const rows = within(await screen.findByTestId('profiles')).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('ND30_A4_STANDARD');
    expect(rows[0]?.textContent).toContain(vi_['doc.layout.period'].replace('{from}', '2026-01-01').replace('{until}', '2027-01-01'));
    expect(rows[0]?.textContent).toContain(vi_['doc.layout.status.published']);
    expect(rows[0]?.textContent).toContain(vi_['doc.layout.confirmation.pending']);
    expect(rows[1]?.textContent).toContain(vi_['doc.layout.status.draft']);
    expect(rows[1]?.textContent).toContain(vi_['doc.layout.period'].replace('{from}', '2027-01-01').replace('{until}', '—'));
    // A reader only reads.
    expect(screen.queryByRole('form', { name: vi_['doc.layout.form.title'] })).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['doc.layout.publish.action'] })).toBeNull();
    expect(page()).toBe('DOC-16');
  });

  it('offers to publish a draft to the approver who did not draft it, under the version it saw, and says why the server refuses', async () => {
    const h = open([profile(1), profile(2, { status: 'DRAFT', version: 1 }), profile(3, { status: 'DRAFT', created_by: ME, version: 1 })], () => new ApiError({ status: 403, code: 'SELF_APPROVAL_DENIED', correlationId: 'c' }));
    mount(<LayoutProfilesScreen route={ROUTE} />, h, APPROVER);
    const buttons = await screen.findAllByRole('button', { name: vi_['doc.layout.publish.action'] });
    expect(buttons).toHaveLength(1);
    const user = userEvent.setup();
    await user.click(buttons[0] as HTMLElement);
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]?.[0]).toBe('publishDocumentLayoutProfile');
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: profile(2).id }, ifMatchVersion: 1 });
    expect((await screen.findByTestId('refusal')).textContent).toBe(vi_['doc.layout.problem.selfApproval']);
  });

  describe('drafting', () => {
    it('fills the form from the revision chosen, refuses a value outside the ranges before it sends, and sends the body of the contract once every value is right', async () => {
      const h = open([profile(1)]);
      mount(<LayoutProfilesScreen route={ROUTE} />, h, MANAGER);
      const user = userEvent.setup();
      const form = await screen.findByRole('form', { name: vi_['doc.layout.form.title'] });
      await within(form).findByRole('option', { name: vi_['doc.layout.field.base.option'].replace('{code}', 'ND30_A4_STANDARD').replace('{revision}', '1') });
      await user.selectOptions(within(form).getByLabelText(vi_['doc.layout.field.base.label']), profile(1).id);
      expect((within(form).getByLabelText(vi_['doc.layout.field.code.label']) as HTMLInputElement).value).toBe('ND30_A4_STANDARD');
      expect((within(form).getByLabelText(vi_['doc.layout.field.margin.label'].replace('{margin}', vi_['doc.layout.margin.left'])) as HTMLInputElement).value).toBe('30');
      expect(within(form).getByTestId('seal-overlap').textContent).toBe(vi_['doc.layout.seal.overlap'].replace('{share}', '35.7'));

      const top = within(form).getByLabelText(vi_['doc.layout.field.margin.label'].replace('{margin}', vi_['doc.layout.margin.top']));
      await user.clear(top);
      await user.type(top, '18');
      await user.type(within(form).getByLabelText(vi_['doc.layout.field.from.label']), '2027-01-01');
      await user.click(within(form).getByRole('button', { name: vi_['doc.layout.form.submit.action'] }));
      expect((await within(form).findAllByText(vi_['doc.layout.field.outOfRange.error'])).length).toBe(1);
      expect(h.command).not.toHaveBeenCalled();

      await user.clear(top);
      await user.type(top, '22');
      await user.click(within(form).getByRole('button', { name: vi_['doc.layout.form.submit.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('createDocumentLayoutProfileRevision');
      const body = (h.command.mock.calls[0]?.[1] as { body: { element_styles: Record<string, unknown>; signature_layout: unknown } & Record<string, unknown> }).body;
      expect(body).toMatchObject({
        profile_code: 'ND30_A4_STANDARD',
        margins_mm: { top: 22, bottom: 20, left: 30, right: 15 },
        font_family: 'Times New Roman',
        font_substitute: 'Tinos',
        number_field_layout: { number: { xMm: 30, yMm: 42, widthMm: 40, heightMm: 6 } },
        watermark_policy: { text: 'CHO XAC NHAN' },
        legal_basis: 'Nghi dinh 30/2020/ND-CP, Phu luc I',
        effective_from: '2027-01-01',
      });
      expect(body.element_styles.body).toEqual({ sizePt: 14, bold: true, italic: false, uppercase: false });
      expect(body.signature_layout).toEqual({ leaderBox: { xMm: 110, yMm: 215, widthMm: 70, heightMm: 40 }, sealBox: { xMm: 95, yMm: 225, widthMm: 40, heightMm: 40 } });
      expect(body).not.toHaveProperty('effective_until');
      expect((await screen.findByTestId('saved')).textContent).toBe(vi_['doc.layout.form.saved']);
    });

    it('tells a seal that is not over a third of the signature, and a box that is not numbers, before it sends', async () => {
      const h = open([profile(1)]);
      mount(<LayoutProfilesScreen route={ROUTE} />, h, MANAGER);
      const user = userEvent.setup();
      const form = await screen.findByRole('form', { name: vi_['doc.layout.form.title'] });
      await within(form).findByRole('option', { name: vi_['doc.layout.field.base.option'].replace('{code}', 'ND30_A4_STANDARD').replace('{revision}', '1') });
      await user.selectOptions(within(form).getByLabelText(vi_['doc.layout.field.base.label']), profile(1).id);
      await user.type(within(form).getByLabelText(vi_['doc.layout.field.from.label']), '2027-01-01');
      const sealX = within(form).getByLabelText(vi_['doc.layout.field.box.label'].replace('{box}', vi_['doc.layout.box.seal']).replace('{side}', vi_['doc.layout.box.x']));
      await user.clear(sealX);
      await user.type(sealX, '10');
      expect(within(form).getByTestId('seal-overlap').textContent).toBe(vi_['doc.layout.seal.overlap'].replace('{share}', '0.0'));
      await user.click(within(form).getByRole('button', { name: vi_['doc.layout.form.submit.action'] }));
      expect(await within(form).findByText(vi_['doc.layout.field.seal.error'])).toBeTruthy();
      await user.clear(sealX);
      await user.type(sealX, 'x');
      expect(within(form).getByTestId('seal-overlap').textContent).toBe('—');
      await user.click(within(form).getByRole('button', { name: vi_['doc.layout.form.submit.action'] }));
      expect(await within(form).findByText(vi_['doc.layout.field.invalid.error'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
    });

    it.each([
      ['LAYOUT_OUT_OF_LEGAL_RANGE', 422, 'doc.layout.problem.outOfRange'],
      ['LEGAL_BASIS_REQUIRED', 422, 'doc.layout.problem.legalBasis'],
      ['TEMPLATE_RANGE_OVERLAP', 409, 'doc.layout.problem.overlap'],
      ['VALIDATION_FAILED', 422, 'doc.layout.problem.invalid'],
      ['SCOPE_DENIED', 403, 'doc.layout.problem.scope'],
      ['OTHER', 500, 'doc.layout.problem.general'],
    ] as const)('says in words what the server refused: %s', async (code, status, key) => {
      const h = open([profile(1)], () => new ApiError({ status, code, correlationId: 'c' }));
      mount(<LayoutProfilesScreen route={ROUTE} />, h, MANAGER);
      const user = userEvent.setup();
      const form = await screen.findByRole('form', { name: vi_['doc.layout.form.title'] });
      await within(form).findByRole('option', { name: vi_['doc.layout.field.base.option'].replace('{code}', 'ND30_A4_STANDARD').replace('{revision}', '1') });
      await user.selectOptions(within(form).getByLabelText(vi_['doc.layout.field.base.label']), profile(1).id);
      await user.type(within(form).getByLabelText(vi_['doc.layout.field.from.label']), '2027-01-01');
      await user.click(within(form).getByRole('button', { name: vi_['doc.layout.form.submit.action'] }));
      expect((await screen.findByTestId('refusal')).textContent).toBe(vi_[key]);
    });

    it('is offered to the person who drafts layouts, never to a reader, in a suspended tenant or without the right to read', async () => {
      mount(<LayoutProfilesScreen route={ROUTE} />, open([profile(1)]), MANAGER);
      expect(await screen.findByRole('form', { name: vi_['doc.layout.form.title'] })).toBeTruthy();
      cleanup();
      const frozen = mountInSession(<LayoutProfilesScreen route={ROUTE} />, open([profile(1)]), { permissions: [...MANAGER, ...APPROVER], mode: 'READ_ONLY' });
      await screen.findByTestId('profiles');
      expect(screen.queryByRole('form', { name: vi_['doc.layout.form.title'] })).toBeNull();
      frozen.unmount();
      mount(<LayoutProfilesScreen route={ROUTE} />, open([profile(1)]), ['doc.layout.manage']);
      expect((await screen.findByTestId('no-read')).textContent).toBe(vi_['doc.layout.read.denied']);
      expect(screen.queryByTestId('profiles')).toBeNull();
    });
  });

  it('says the profiles could not be read and reads them again on request', async () => {
    let fails = true;
    const h = open(() => (fails ? new ApiError({ status: 503, code: 'UNAVAILABLE', correlationId: 'c' }) : [profile(1)]));
    mount(<LayoutProfilesScreen route={ROUTE} />, h, READER);
    const user = userEvent.setup();
    const retry = await screen.findByRole('button', { name: vi_['states.retry.action'] });
    expect(screen.queryByTestId('profiles')).toBeNull();
    fails = false;
    await user.click(retry);
    expect(await screen.findByTestId('profiles')).toBeTruthy();
  });
});

describe('the rules of the layout form', () => {
  const base = toProfile(profile(1));
  const filled = () => ({ ...formFrom(base), effectiveFrom: '2027-01-01' });

  it('starts from a revision and builds the body of the command from it', () => {
    const form = filled();
    expect(form).toMatchObject({ baseId: base.id, profileCode: 'ND30_A4_STANDARD', legalBasis: base.legalBasis });
    expect(validateForm(form)).toEqual({ margins: {}, sizes: {} });
    expect(hasProblems(validateForm(form))).toBe(false);
    const body = layoutBody({ ...form, profileCode: ' NEW_PROFILE ', effectiveUntil: '2028-01-01' }, base);
    expect(body).toMatchObject({ profile_code: 'NEW_PROFILE', effective_until: '2028-01-01', font_substitute: 'Tinos' });
    expect(layoutBody(form, { ...base, fontSubstitute: null })).not.toHaveProperty('font_substitute');
    expect(hasProblems(validateForm(EMPTY_FORM))).toBe(true);
  });

  it('judges the code, the days, the legal basis, the margins, the sizes and the boxes', () => {
    const problems = validateForm({
      ...filled(),
      profileCode: 'lower',
      effectiveFrom: '2027-02-30',
      effectiveUntil: '2027-01-01',
      legalBasis: 'x'.repeat(2001),
      margins: { top: '', bottom: 'a', left: '29', right: '15' },
      sizes: { ...filled().sizes, body: '', motto: 'big', pageNumber: '15' },
      leader: { x: '', y: '', width: '', height: '' },
    });
    expect(problems).toMatchObject({ profileCode: 'invalid', effectiveFrom: 'invalid', legalBasis: 'invalid', boxes: 'invalid', margins: { top: 'required', bottom: 'invalid', left: 'outOfRange' }, sizes: { body: 'required', motto: 'invalid', pageNumber: 'outOfRange' } });
    expect(validateForm({ ...filled(), profileCode: '', effectiveFrom: '', legalBasis: ' ' })).toMatchObject({ profileCode: 'required', effectiveFrom: 'required', legalBasis: 'required' });
    expect(validateForm({ ...filled(), effectiveUntil: 'never' }).effectiveUntil).toBe('invalid');
    expect(validateForm({ ...filled(), effectiveUntil: '2027-01-01' }).effectiveUntil).toBe('invalid');
    expect(validateForm({ ...filled(), effectiveUntil: '2027-06-01' }).effectiveUntil).toBeUndefined();
    expect(validateForm({ ...filled(), seal: { x: '10', y: '225', width: '40', height: '40' } }).seal).toBe('outOfRange');
    // Off the page (A4, 210 x 297 mm).
    expect(validateForm({ ...filled(), leader: { x: '110', y: '400', width: '70', height: '40' }, seal: { x: '95', y: '400', width: '40', height: '40' } }).boxes).toBe('outOfRange');
    // Beside the signature, not over it; and boxes that have no size.
    expect(validateForm({ ...filled(), seal: { x: '95', y: '0', width: '40', height: '40' } }).seal).toBe('outOfRange');
    expect(validateForm({ ...filled(), seal: { x: '95', y: '225', width: '40', height: '0' } }).boxes).toBe('outOfRange');
    expect(validateForm({ ...filled(), leader: { x: '110', y: '215', width: '70', height: '0' } }).boxes).toBe('outOfRange');
  });

  it('measures the seal over the signature and reads a box only from numbers', () => {
    const leader = { xMm: 100, yMm: 0, widthMm: 60, heightMm: 30 };
    expect(sealOverlapRatio(leader, { xMm: 80, yMm: 0, widthMm: 40, heightMm: 40 })).toBeCloseTo(1 / 3, 6);
    expect(sealOverlapRatio(leader, { xMm: 10, yMm: 0, widthMm: 40, heightMm: 40 })).toBe(0);
    expect(sealOverlapRatio({ ...leader, widthMm: 0 }, { xMm: 80, yMm: 0, widthMm: 40, heightMm: 40 })).toBe(0);
    expect(sealWithinRange(leader, { xMm: 80, yMm: 0, widthMm: 40, heightMm: 40 })).toBe(true);
    expect(sealWithinRange(leader, { xMm: 100, yMm: 0, widthMm: 20, heightMm: 40 })).toBe(false);
    expect(boxOfForm({ x: '1', y: '2.5', width: '3', height: '4' })).toEqual({ xMm: 1, yMm: 2.5, widthMm: 3, heightMm: 4 });
    expect(boxOfForm({ x: '1', y: '-2', width: '3', height: '4' })).toBeUndefined();
  });

  it('lets someone else publish a draft, reads what the server refused, and leaves out what is not a profile', () => {
    expect(canPublish({ status: 'DRAFT', createdBy: OTHER }, ME)).toBe(true);
    expect(canPublish({ status: 'DRAFT', createdBy: ME }, ME)).toBe(false);
    expect(canPublish({ status: 'PUBLISHED', createdBy: OTHER }, ME)).toBe(false);
    expect(canPublish({ status: 'DRAFT', createdBy: ME }, undefined)).toBe(true);
    const refused = (code: string) => describeProblem(new ApiError({ status: 409, code, correlationId: 'c' }));
    expect(['LAYOUT_OUT_OF_LEGAL_RANGE', 'LEGAL_BASIS_REQUIRED', 'SELF_APPROVAL_DENIED', 'LAYOUT_STATE_INVALID', 'TEMPLATE_RANGE_OVERLAP', 'VERSION_CONFLICT', 'VALIDATION_FAILED', 'INVALID_REQUEST', 'SCOPE_DENIED', 'RESOURCE_NOT_FOUND', 'OTHER'].map(refused)).toEqual([
      'outOfRange',
      'legalBasis',
      'selfApproval',
      'state',
      'overlap',
      'conflict',
      'invalid',
      'invalid',
      'scope',
      'notFound',
      'general',
    ]);
    expect(describeProblem(new Error('x'))).toBe('general');
    const odd = toProfile({ id: 'x', status: 'WEIRD', confirmation_status: 'CONFIRMED', margins_mm: null, element_styles: null, signature_layout: null, number_field_layout: [], watermark_policy: 4 });
    expect(odd).toMatchObject({ status: 'DRAFT', confirmationStatus: 'CONFIRMED', marginsMm: { top: 0 }, numberFieldLayout: {}, watermarkPolicy: {}, effectiveUntil: null });
    expect(toProfile(null)).toMatchObject({ id: '', revision: 0 });
  });
});
