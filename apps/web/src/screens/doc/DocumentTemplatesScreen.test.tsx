import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import DocumentTemplatesScreen from './DocumentTemplatesScreen';
import { SECOND_TENANT, TENANT, harness, mount, mountInSession, routeOf } from './test-support';

const ROUTE = routeOf('DOC-14', 'FR-DOC-14');
const ME = TENANT.membershipId;
const OTHER = '00000000-0000-4000-8000-0000000000aa';
const THIRD = '00000000-0000-4000-8000-0000000000bb';
const EVIDENCE = '00000000-0000-4000-8000-0000000000e1';

const READ = 'doc.template.read';
const MANAGE = 'doc.template.manage';
const APPROVE = 'doc.template.approve';
const CONFIRM = 'doc.template.confirm_legal';
const ADMIN_PERMISSIONS = [READ, MANAGE, APPROVE];
const LEGAL_PERMISSIONS = [READ, CONFIRM];
const EVERYTHING = [READ, MANAGE, APPROVE, CONFIRM];

const fill = (text: string, values: Record<string, string | number>): string => Object.entries(values).reduce((out, [key, value]) => out.replace(`{${key}}`, String(value)), text);

const template = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`,
  template_code: `MNE-TT44-M0${n}`,
  revision: 1,
  group_code: 'REPORT_MONITORING',
  doc_type_code: 'BC',
  form_code: `M0${n}`,
  title: `Monitoring report M0${n}`,
  source_module: 'MNE',
  legal_basis: 'Thông tư 44/2026/TT-BTC [CXN-10]',
  legal_confirmation_ref: null,
  confirmation_status: 'PENDING_CONFIRMATION',
  watermark_text: 'CHƯA XÁC NHẬN PHÁP LÝ [CXN-10]',
  cxn_refs: ['CXN-10'],
  origin: 'PLATFORM_PACK',
  pack_version: '2026.10.1',
  layout_profile_id: '00000000-0000-4000-8000-0000000000f1',
  layout_confirmation_status: 'CONFIRMED',
  renders_watermarked: true,
  effective_from: '2026-01-01',
  effective_until: null,
  status: 'PUBLISHED',
  version: 2,
  created_by: OTHER,
  approved_by: THIRD,
  ...overrides,
});

const ROWS = [
  template(2),
  template(3, { status: 'DRAFT', version: 1, approved_by: null, origin: 'TENANT', pack_version: null, watermark_text: 'Awaiting' }),
  template(4, { cxn_refs: [], legal_basis: 'Nghị định 30/2020/NĐ-CP', watermark_text: null, effective_until: '2027-01-01' }),
  template(5, { confirmation_status: 'CONFIRMED', legal_confirmation_ref: 'CXN-10-OK', renders_watermarked: false, layout_confirmation_status: 'CONFIRMED' }),
  template(6, { confirmation_status: 'CONFIRMED', legal_confirmation_ref: 'CXN-10-OK', layout_confirmation_status: 'PENDING_CONFIRMATION' }),
  template(7, { status: 'RETIRED', version: 3 }),
];

function answer(operation: string): unknown {
  if (operation === 'listDocumentTemplates') return { items: ROWS, next_cursor: null };
  return new Error('unexpected read');
}

const rowOf = (code: string): HTMLElement => screen.getByText(code).closest('tr') as HTMLElement;
const button = (key: string, values: Record<string, string | number> = {}) => screen.getByRole('button', { name: fill((vi_ as Record<string, string>)[key] ?? key, values) });
const maybeButton = (key: string, values: Record<string, string | number> = {}) => screen.queryByRole('button', { name: fill((vi_ as Record<string, string>)[key] ?? key, values) });

afterEach(cleanup);

describe('DocumentTemplatesScreen (DOC-14)', () => {
  it('AC-ST-DOC-006-3: lists the revisions with the confirmation label and the CXN of the legal basis, the watermark and the period', async () => {
    const h = harness(answer);
    mount(<DocumentTemplatesScreen route={ROUTE} />, h, [READ]);
    expect(await screen.findByText('MNE-TT44-M02')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['doc.templates.page.title']);
    expect(h.read).toHaveBeenCalledWith('listDocumentTemplates', { query: { limit: 50 } });

    const pending = rowOf('MNE-TT44-M02');
    expect(within(pending).getByText(fill(vi_['doc.templates.confirmation.pending'], { tags: '[CXN-10]' }))).toBeTruthy();
    expect(within(pending).getByText(fill(vi_['doc.templates.watermark.text'], { text: 'CHƯA XÁC NHẬN PHÁP LÝ [CXN-10]' }))).toBeTruthy();
    expect(within(pending).getByText('Thông tư 44/2026/TT-BTC [CXN-10]')).toBeTruthy();
    expect(within(pending).getByText(fill(vi_['doc.templates.period.open'], { from: '2026-01-01' }))).toBeTruthy();
    expect(within(pending).getByText(fill(vi_['doc.templates.origin.pack'], { version: '2026.10.1' }))).toBeTruthy();
    expect(within(pending).getByText(vi_['doc.templates.state.published'])).toBeTruthy();
    expect(within(pending).getByText('M02', { selector: 'td' })).toBeTruthy();

    // A text that names no confirmation still carries the generic label; a closed period says where it ends.
    const noTag = rowOf('MNE-TT44-M04');
    expect(within(noTag).getByText(fill(vi_['doc.templates.confirmation.pending'], { tags: '[CXN]' }))).toBeTruthy();
    expect(within(noTag).getByText(fill(vi_['doc.templates.period.closed'], { from: '2026-01-01', until: '2027-01-01' }))).toBeTruthy();
    expect(within(noTag).queryByText(/Watermark/)).toBeNull();

    const draft = rowOf('MNE-TT44-M03');
    expect(within(draft).getByText(vi_['doc.templates.state.draft'])).toBeTruthy();
    expect(within(draft).getByText(vi_['doc.templates.origin.tenant'])).toBeTruthy();

    const confirmed = rowOf('MNE-TT44-M05');
    expect(within(confirmed).getByText(vi_['doc.templates.confirmation.confirmed'])).toBeTruthy();
    expect(within(confirmed).getByText(fill(vi_['doc.templates.confirmation.reference'], { reference: 'CXN-10-OK' }))).toBeTruthy();
    expect(within(confirmed).queryByText(vi_['doc.templates.layout.pending'])).toBeNull();
    expect(within(rowOf('MNE-TT44-M06')).getByText(vi_['doc.templates.layout.pending'])).toBeTruthy();

    // A retired revision no longer waits for anything.
    const retired = rowOf('MNE-TT44-M07');
    expect(within(retired).getByText(vi_['doc.templates.state.retired'])).toBeTruthy();
    expect(within(retired).queryByText(/Chờ xác nhận/)).toBeNull();
    expect(screen.getByText(vi_['doc.templates.rule.notice'])).toBeTruthy();
    expect(screen.getByText(fill(vi_['doc.templates.count.text'], { count: 6 }))).toBeTruthy();
  });

  it('asks the server for the group, the status and the date, and narrows by text in the page', async () => {
    const h = harness(answer);
    mount(<DocumentTemplatesScreen route={ROUTE} />, h, [READ]);
    await screen.findByText('MNE-TT44-M02');
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(vi_['doc.templates.search.label']), 'm05');
    await user.click(screen.getByRole('button', { name: vi_['doc.templates.filter.action'] }));
    expect(screen.queryByText('MNE-TT44-M02')).toBeNull();
    expect(screen.getByText('MNE-TT44-M05')).toBeTruthy();
    await user.clear(screen.getByLabelText(vi_['doc.templates.search.label']));
    await user.type(screen.getByLabelText(vi_['doc.templates.search.label']), 'no such template anywhere');
    await user.click(screen.getByRole('button', { name: vi_['doc.templates.filter.action'] }));
    expect(screen.getByText(vi_['doc.templates.filtered.empty'])).toBeTruthy();
    await user.clear(screen.getByLabelText(vi_['doc.templates.search.label']));
    await user.selectOptions(screen.getByLabelText(vi_['doc.templates.group.label']), 'REPORT_MONITORING');
    await user.selectOptions(screen.getByLabelText(vi_['doc.templates.filterStatus.label']), 'PUBLISHED');
    await user.type(screen.getByLabelText(vi_['doc.templates.asOf.label']), '2026-10-22');
    await user.click(screen.getByRole('button', { name: vi_['doc.templates.filter.action'] }));
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('listDocumentTemplates', { query: { limit: 50, group_code: 'REPORT_MONITORING', status: 'PUBLISHED', as_of_date: '2026-10-22' } }));
  });

  it('loads the next page of revisions on request', async () => {
    const h = harness((operation, input) => {
      if (operation !== 'listDocumentTemplates') return answer(operation);
      const cursor = (input as { query?: { cursor?: string } }).query?.cursor;
      return cursor === undefined ? { items: [ROWS[0]], next_cursor: 'p2' } : { items: [ROWS[3]], next_cursor: null };
    });
    mount(<DocumentTemplatesScreen route={ROUTE} />, h, [READ]);
    await screen.findByText('MNE-TT44-M02');
    await userEvent.setup().click(screen.getByRole('button', { name: vi_['doc.templates.more.action'] }));
    expect(await screen.findByText('MNE-TT44-M05')).toBeTruthy();
    expect(screen.queryByRole('button', { name: vi_['doc.templates.more.action'] })).toBeNull();
  });

  describe('publishing', () => {
    it('offers the publication of a draft to someone who did not draft it, with the version that was read', async () => {
      const h = harness(answer, () => ({ status: 'PUBLISHED', resource_version: 2, resource_id: ROWS[1]?.id }));
      mount(<DocumentTemplatesScreen route={ROUTE} />, h, ADMIN_PERMISSIONS);
      await screen.findByText('MNE-TT44-M03');
      const user = userEvent.setup();
      await user.click(button('doc.templates.publish.label', { code: 'MNE-TT44-M03', revision: 1 }));
      expect(screen.getByText(vi_['doc.templates.publish.hint'])).toBeTruthy();
      await user.click(screen.getByRole('button', { name: vi_['doc.templates.publish.confirm.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('publishDocumentTemplate');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: ROWS[1]?.id }, ifMatchVersion: 1 });
      expect(await screen.findByText(fill(vi_['doc.templates.publish.done.notice'], { code: 'MNE-TT44-M03' }))).toBeTruthy();
      expect(screen.queryByRole('button', { name: vi_['doc.templates.publish.confirm.action'] })).toBeNull();
    });

    it('does not offer the drafter to publish their own draft and says that someone else has to', async () => {
      const mine = [template(3, { status: 'DRAFT', version: 1, approved_by: null, created_by: ME.toUpperCase() })];
      mount(<DocumentTemplatesScreen route={ROUTE} />, harness(() => ({ items: mine, next_cursor: null })), ADMIN_PERMISSIONS);
      await screen.findByText('MNE-TT44-M03');
      expect(maybeButton('doc.templates.publish.label', { code: 'MNE-TT44-M03', revision: 1 })).toBeNull();
      expect(screen.getByText(vi_['doc.templates.publish.other.hint'])).toBeTruthy();
      // The same drafter can still retire it.
      expect(button('doc.templates.retire.label', { code: 'MNE-TT44-M03', revision: 1 })).toBeTruthy();
    });

    it.each([
      ['SELF_APPROVAL_DENIED', 403, 'doc.templates.problem.selfApproval.text'],
      ['TEMPLATE_RANGE_OVERLAP', 409, 'doc.templates.problem.rangeOverlap.text'],
      ['VERSION_CONFLICT', 409, 'doc.templates.problem.conflict.text'],
      ['TEMPLATE_STATE_INVALID', 409, 'doc.templates.problem.stateInvalid.text'],
      ['SCOPE_DENIED', 403, 'doc.templates.problem.denied.text'],
      ['RESOURCE_NOT_FOUND', 404, 'doc.templates.problem.notFound.text'],
      ['VALIDATION_FAILED', 422, 'doc.templates.problem.invalid.text'],
      ['SESSION_EXPIRED', 401, 'doc.templates.problem.session.text'],
      ['CONFIRMATION_REF_REQUIRED', 422, 'doc.templates.problem.referenceRequired.text'],
      ['SOMETHING_ELSE', 500, 'doc.templates.problem.general.text'],
    ] as const)('shows the refusal %s in words and lets the person cancel', async (code, status, key) => {
      const h = harness(answer, () => new ApiError({ status, code, correlationId: 'c' }));
      mount(<DocumentTemplatesScreen route={ROUTE} />, h, ADMIN_PERMISSIONS);
      await screen.findByText('MNE-TT44-M03');
      const user = userEvent.setup();
      await user.click(button('doc.templates.publish.label', { code: 'MNE-TT44-M03', revision: 1 }));
      await user.click(screen.getByRole('button', { name: vi_['doc.templates.publish.confirm.action'] }));
      expect((await screen.findByRole('alert')).textContent).toBe((vi_ as Record<string, string>)[key]);
      await user.click(screen.getByRole('button', { name: vi_['doc.templates.publish.cancel.action'] }));
      expect(screen.queryByRole('button', { name: vi_['doc.templates.publish.confirm.action'] })).toBeNull();
    });

    it('shows a general message for a failure that is not an answer of the server', async () => {
      const h = harness(answer, () => new Error('socket closed'));
      mount(<DocumentTemplatesScreen route={ROUTE} />, h, ADMIN_PERMISSIONS);
      await screen.findByText('MNE-TT44-M03');
      const user = userEvent.setup();
      await user.click(button('doc.templates.publish.label', { code: 'MNE-TT44-M03', revision: 1 }));
      await user.click(screen.getByRole('button', { name: vi_['doc.templates.publish.confirm.action'] }));
      expect((await screen.findByRole('alert')).textContent).toBe(vi_['doc.templates.problem.general.text']);
    });
  });

  describe('legal confirmation', () => {
    it('offers it to the legal officer for a published template that waits, checks the fields, and sends the reference and the evidence', async () => {
      const h = harness(answer, () => ({ status: 'CONFIRMED', resource_version: 3, resource_id: ROWS[0]?.id }));
      mount(<DocumentTemplatesScreen route={ROUTE} />, h, LEGAL_PERMISSIONS);
      await screen.findByText('MNE-TT44-M02');
      // Neither a draft nor a confirmed template can be confirmed.
      for (const code of ['MNE-TT44-M03', 'MNE-TT44-M05', 'MNE-TT44-M07']) expect(maybeButton('doc.templates.legal.label', { code, revision: 1 })).toBeNull();
      const user = userEvent.setup();
      await user.click(button('doc.templates.legal.label', { code: 'MNE-TT44-M02', revision: 1 }));
      await user.click(screen.getByRole('button', { name: vi_['doc.templates.legal.confirm.action'] }));
      expect(screen.getAllByRole('alert').map((node) => node.textContent)).toEqual([vi_['doc.templates.field.required'], vi_['doc.templates.field.required']]);
      expect(h.command).not.toHaveBeenCalled();
      await user.type(screen.getByLabelText(vi_['doc.templates.legal.reference.label']), 'ab');
      await user.type(screen.getByLabelText(vi_['doc.templates.legal.evidence.label']), 'not-a-uuid');
      fireEvent.change(screen.getByLabelText(vi_['doc.templates.legal.note.label']), { target: { value: 'x'.repeat(1001) } });
      await user.click(screen.getByRole('button', { name: vi_['doc.templates.legal.confirm.action'] }));
      expect(screen.getAllByRole('alert').map((node) => node.textContent)).toEqual([vi_['doc.templates.field.tooShort'], vi_['doc.templates.field.uuid'], vi_['doc.templates.field.tooLong']]);
      fireEvent.change(screen.getByLabelText(vi_['doc.templates.legal.reference.label']), { target: { value: 'x'.repeat(51) } });
      await user.click(screen.getByRole('button', { name: vi_['doc.templates.legal.confirm.action'] }));
      expect(screen.getAllByRole('alert')[0]?.textContent).toBe(vi_['doc.templates.field.tooLong']);
      await user.clear(screen.getByLabelText(vi_['doc.templates.legal.reference.label']));
      await user.type(screen.getByLabelText(vi_['doc.templates.legal.reference.label']), '  CXN-10  ');
      await user.clear(screen.getByLabelText(vi_['doc.templates.legal.evidence.label']));
      await user.type(screen.getByLabelText(vi_['doc.templates.legal.evidence.label']), EVIDENCE.toUpperCase());
      await user.clear(screen.getByLabelText(vi_['doc.templates.legal.note.label']));
      await user.click(screen.getByRole('button', { name: vi_['doc.templates.legal.confirm.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('confirmDocumentTemplateLegalBasis');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: ROWS[0]?.id }, body: { legal_confirmation_ref: 'CXN-10', evidence_document_id: EVIDENCE }, ifMatchVersion: 2 });
      expect((h.command.mock.calls[0]?.[1] as { body: Record<string, unknown> }).body).not.toHaveProperty('note');
      expect(await screen.findByText(fill(vi_['doc.templates.legal.done.notice'], { code: 'MNE-TT44-M02' }))).toBeTruthy();
    });

    it('sends a note when one is written, and shows the refusal of a missing reference', async () => {
      const h = harness(answer, () => new ApiError({ status: 422, code: 'CONFIRMATION_REF_REQUIRED', correlationId: 'c' }));
      mount(<DocumentTemplatesScreen route={ROUTE} />, h, LEGAL_PERMISSIONS);
      await screen.findByText('MNE-TT44-M02');
      const user = userEvent.setup();
      await user.click(button('doc.templates.legal.label', { code: 'MNE-TT44-M02', revision: 1 }));
      await user.type(screen.getByLabelText(vi_['doc.templates.legal.reference.label']), 'CXN-10');
      await user.type(screen.getByLabelText(vi_['doc.templates.legal.evidence.label']), EVIDENCE);
      await user.type(screen.getByLabelText(vi_['doc.templates.legal.note.label']), ' gazette checked ');
      await user.click(screen.getByRole('button', { name: vi_['doc.templates.legal.confirm.action'] }));
      expect((await screen.findByRole('alert')).textContent).toBe(vi_['doc.templates.problem.referenceRequired.text']);
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ body: { note: 'gazette checked' } });
      await user.click(screen.getByRole('button', { name: vi_['doc.templates.legal.cancel.action'] }));
      expect(screen.queryByLabelText(vi_['doc.templates.legal.reference.label'])).toBeNull();
    });

    it('does not offer the confirmation of their own work to the drafter or the publisher, and says that someone else must', async () => {
      const rows = [template(2, { created_by: ME }), template(3, { approved_by: ME.toUpperCase() })];
      mount(<DocumentTemplatesScreen route={ROUTE} />, harness(() => ({ items: rows, next_cursor: null })), LEGAL_PERMISSIONS);
      await screen.findByText('MNE-TT44-M02');
      for (const code of ['MNE-TT44-M02', 'MNE-TT44-M03']) expect(maybeButton('doc.templates.legal.label', { code, revision: 1 })).toBeNull();
      expect(screen.getAllByText(vi_['doc.templates.legal.other.hint'])).toHaveLength(2);
    });
  });

  describe('retirement', () => {
    it('retires a revision after a reason, with the version that was read', async () => {
      const h = harness(answer, () => ({ status: 'RETIRED', resource_version: 3, resource_id: ROWS[0]?.id }));
      mount(<DocumentTemplatesScreen route={ROUTE} />, h, EVERYTHING);
      await screen.findByText('MNE-TT44-M02');
      expect(maybeButton('doc.templates.retire.label', { code: 'MNE-TT44-M07', revision: 1 })).toBeNull();
      const user = userEvent.setup();
      await user.click(button('doc.templates.retire.label', { code: 'MNE-TT44-M02', revision: 1 }));
      await user.click(screen.getByRole('button', { name: vi_['doc.templates.retire.confirm.action'] }));
      expect((await screen.findByRole('alert')).textContent).toBe(vi_['doc.templates.field.required']);
      expect(h.command).not.toHaveBeenCalled();
      await user.type(screen.getByLabelText(vi_['doc.templates.retire.reason.label']), 'short');
      await user.click(screen.getByRole('button', { name: vi_['doc.templates.retire.confirm.action'] }));
      expect((await screen.findByRole('alert')).textContent).toBe(vi_['doc.templates.field.tooShort']);
      fireEvent.change(screen.getByLabelText(vi_['doc.templates.retire.reason.label']), { target: { value: 'x'.repeat(2001) } });
      await user.click(screen.getByRole('button', { name: vi_['doc.templates.retire.confirm.action'] }));
      expect((await screen.findByRole('alert')).textContent).toBe(vi_['doc.templates.field.tooLong']);
      await user.clear(screen.getByLabelText(vi_['doc.templates.retire.reason.label']));
      await user.type(screen.getByLabelText(vi_['doc.templates.retire.reason.label']), ' The form was withdrawn by its issuer ');
      await user.click(screen.getByRole('button', { name: vi_['doc.templates.retire.confirm.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('retireDocumentTemplate');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: ROWS[0]?.id }, body: { reason: 'The form was withdrawn by its issuer' }, ifMatchVersion: 2 });
      expect(await screen.findByText(fill(vi_['doc.templates.retire.done.notice'], { code: 'MNE-TT44-M02' }))).toBeTruthy();
    });
  });

  describe('who may do what', () => {
    it('offers a reader nothing but the list', async () => {
      mount(<DocumentTemplatesScreen route={ROUTE} />, harness(answer), [READ]);
      await screen.findByText('MNE-TT44-M02');
      expect(screen.queryByRole('button', { name: /Công bố|Ghi xác nhận|Ngừng dùng/ })).toBeNull();
    });

    it('offers each step only to the holder of its permission', async () => {
      mount(<DocumentTemplatesScreen route={ROUTE} />, harness(answer), [READ, MANAGE]);
      await screen.findByText('MNE-TT44-M02');
      expect(maybeButton('doc.templates.publish.label', { code: 'MNE-TT44-M03', revision: 1 })).toBeNull();
      expect(maybeButton('doc.templates.legal.label', { code: 'MNE-TT44-M02', revision: 1 })).toBeNull();
      expect(button('doc.templates.retire.label', { code: 'MNE-TT44-M02', revision: 1 })).toBeTruthy();
    });

    it('lets the server decide while the grants are not known', async () => {
      mountInSession(<DocumentTemplatesScreen route={ROUTE} />, harness(answer), { permissions: undefined });
      await screen.findByText('MNE-TT44-M02');
      expect(button('doc.templates.publish.label', { code: 'MNE-TT44-M03', revision: 1 })).toBeTruthy();
      expect(button('doc.templates.legal.label', { code: 'MNE-TT44-M02', revision: 1 })).toBeTruthy();
    });

    it('offers nothing to anybody while the tenant is suspended, and closes a panel that was open', async () => {
      const h = harness(answer);
      const view = mountInSession(<DocumentTemplatesScreen route={ROUTE} />, h, { permissions: EVERYTHING });
      await screen.findByText('MNE-TT44-M02');
      await userEvent.setup().click(button('doc.templates.retire.label', { code: 'MNE-TT44-M02', revision: 1 }));
      expect(screen.getByLabelText(vi_['doc.templates.retire.reason.label'])).toBeTruthy();
      view.rerenderWith({ permissions: EVERYTHING, mode: 'READ_ONLY' });
      expect(await screen.findByText(vi_['doc.templates.frozen.notice'])).toBeTruthy();
      expect(screen.queryByLabelText(vi_['doc.templates.retire.reason.label'])).toBeNull();
      expect(screen.queryByRole('button', { name: /Công bố|Ghi xác nhận|Ngừng dùng/ })).toBeNull();
    });
  });

  it('starts over when the tenant changes: the open form and the filters of the first tenant never reach the second', async () => {
    const h = harness(answer);
    const view = mountInSession(<DocumentTemplatesScreen route={ROUTE} />, h, { permissions: EVERYTHING });
    await screen.findByText('MNE-TT44-M02');
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(vi_['doc.templates.search.label']), 'm05');
    await user.click(button('doc.templates.retire.label', { code: 'MNE-TT44-M02', revision: 1 }));
    await user.type(screen.getByLabelText(vi_['doc.templates.retire.reason.label']), 'written for the first tenant');
    view.rerenderWith({ permissions: EVERYTHING, tenant: SECOND_TENANT });
    await waitFor(() => expect(screen.queryByLabelText(vi_['doc.templates.retire.reason.label'])).toBeNull());
    expect((screen.getByLabelText(vi_['doc.templates.search.label']) as HTMLInputElement).value).toBe('');
    expect(h.command).not.toHaveBeenCalled();
  });

  describe('UI-DOC-14: the standard states', () => {
    it.each([
      ['empty', { items: [], next_cursor: null }, vi_['states.empty.title']],
      ['denied', new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }), vi_['states.denied.title']],
      ['offline', new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), vi_['states.offline.title']],
      ['error', new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' }), vi_['states.error.title']],
      ['signed out', new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' }), vi_['states.signedOut.title']],
    ])('UI-DOC-14: shows the %s state', async (_name, reply, title) => {
      mount(<DocumentTemplatesScreen route={ROUTE} />, harness((operation) => (operation === 'listDocumentTemplates' ? reply : new Error('unexpected read'))));
      expect(await screen.findByText(title)).toBeTruthy();
      // The filters stay, so a filter that has no revision can still be changed.
      expect(screen.getByLabelText(vi_['doc.templates.group.label'])).toBeTruthy();
    });

    it('UI-DOC-14: shows the loading state first and names the page, the table and the forms for assistive technology', async () => {
      mount(<DocumentTemplatesScreen route={ROUTE} />, harness(() => new Promise(() => undefined)));
      expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
      expect(screen.getByRole('region', { name: vi_['doc.templates.page.title'] })).toBeTruthy();
    });

    it('UI-DOC-14: gives every field and every action of the loaded screen an accessible name', async () => {
      mount(<DocumentTemplatesScreen route={ROUTE} />, harness(answer), EVERYTHING);
      await screen.findByText('MNE-TT44-M02');
      for (const control of [screen.getByRole('searchbox'), ...screen.getAllByRole('combobox'), screen.getByLabelText(vi_['doc.templates.asOf.label'])]) {
        expect((control as HTMLInputElement).labels?.length).toBeGreaterThan(0);
      }
      for (const action of screen.getAllByRole('button')) expect((action.getAttribute('aria-label') ?? action.textContent ?? '').trim().length).toBeGreaterThan(0);
      expect(screen.getAllByRole('columnheader').length).toBeGreaterThanOrEqual(8);
    });

    it('UI-DOC-14: retries the list after an error', async () => {
      let failing = true;
      const h = harness((operation) => {
        if (operation !== 'listDocumentTemplates') return new Error('unexpected read');
        return failing ? new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' }) : { items: ROWS, next_cursor: null };
      });
      mount(<DocumentTemplatesScreen route={ROUTE} />, h);
      expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
      failing = false;
      await userEvent.setup().click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
      expect(await screen.findByText('MNE-TT44-M02')).toBeTruthy();
    });
  });
});
