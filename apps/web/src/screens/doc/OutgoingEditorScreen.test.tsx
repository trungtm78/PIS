import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import OutgoingEditorScreen from './OutgoingEditorScreen';
import { SECOND_TENANT, TENANT, harness, mount, mountInSession, routeOf } from './test-support';
import type { Harness } from './test-support';

const ROUTE = routeOf('DOC-02', 'FR-DOC-02');
const DOC_ID = '00000000-0000-4000-8000-000000000201';
const UNIT = '00000000-0000-4000-8000-000000000f01';
const TEMPLATE_ID = '00000000-0000-4000-8000-000000000101';
const SIGNER = '00000000-0000-4000-8000-0000000000b2';
const ALL = ['doc.outgoing.read', 'doc.outgoing.create', 'doc.outgoing.edit', 'doc.outgoing.submit', 'doc.outgoing.cancel', 'doc.render'];

const fill = (text: string, values: Record<string, string | number>): string => Object.entries(values).reduce((out, [key, value]) => out.replace(`{${key}}`, String(value)), text);
const problem = (code: string, status: number, extensions: Record<string, unknown> = {}, detail?: string) => new ApiError({ status, code, correlationId: 'c', extensions, ...(detail === undefined ? {} : { detail }) });

const template = (overrides: Record<string, unknown> = {}) => ({
  id: TEMPLATE_ID,
  template_code: 'QD-DEFAULT',
  revision: 1,
  group_code: 'DECISION',
  doc_type_code: 'QD',
  form_code: null,
  title: 'Decision',
  source_module: null,
  legal_basis: 'ND 30/2020',
  legal_confirmation_ref: null,
  confirmation_status: 'PENDING_CONFIRMATION',
  watermark_text: 'WATERMARK',
  cxn_refs: [],
  origin: 'PLATFORM_PACK',
  pack_version: '1',
  layout_profile_id: '00000000-0000-4000-8000-0000000000f1',
  layout_confirmation_status: 'PENDING_CONFIRMATION',
  renders_watermarked: true,
  effective_from: '2026-01-01',
  effective_until: null,
  status: 'PUBLISHED',
  version: 1,
  created_by: SIGNER,
  approved_by: null,
  ...overrides,
});

const detail = (overrides: Record<string, unknown> = {}) => ({
  id: DOC_ID,
  document_id: '00000000-0000-4000-8000-000000000301',
  title: 'Decision on the capital plan',
  doc_type_code: 'QD',
  status: 'DRAFT',
  effect_status: 'PENDING',
  urgency: 'KHAN',
  circulation: 'INTERNAL_CIRCULATION',
  drafting_unit_id: UNIT,
  drafter_user_id: TENANT.membershipId,
  signer_user_id: SIGNER,
  signer_title: 'CHAIRMAN',
  signing_mode: 'DIRECT',
  delegation_id: null,
  template_id: TEMPLATE_ID,
  payload_sha256: 'a'.repeat(64),
  payload: { agency: 'People Committee', place: 'Cao Bang', title: 'Decision', body: 'The body', content_blocks: { annex: 'Annex 1' }, amount_vnd: '1000' },
  recipients: [{ kind: 'EXTERNAL_AGENCY', name: 'Department of Finance' }],
  latest_review: null,
  versions: [],
  current_version_id: null,
  cancel_reason: null,
  version: 3,
  created_at: '2026-10-23T03:00:00.000Z',
  ...overrides,
});

function world(state: { doc?: Record<string, unknown> | Error; commands?: Record<string, unknown> } = {}) {
  const read = (operation: string): unknown => {
    switch (operation) {
      case 'listDocumentTemplates':
        return { items: [template(), template({ id: '00000000-0000-4000-8000-000000000102', template_code: 'CV-DEFAULT', doc_type_code: 'CV', title: 'Letter', renders_watermarked: false })], next_cursor: null };
      case 'getDocumentTemplate':
        return { ...template(), body_blocks: { blocks: [{ kind: 'heading', text: '{{title}}' }, { kind: 'paragraph', text: '{{body}}' }, { kind: 'paragraph', text: '{{content_blocks.annex}}' }] }, placeholder_schema: { required: ['title', 'body'] } };
      case 'getOutgoingDocument':
        return state.doc ?? new Error('unexpected read');
      case 'getDocumentVersionDownload':
        return { url: 'mock://documents/preview?expires=1' };
      default:
        return new Error(`unexpected read ${operation}`);
    }
  };
  const command = (operation: string): unknown => {
    const reply = state.commands?.[operation];
    if (reply !== undefined) return reply;
    if (operation === 'renderDocumentPreview') return { operation_id: 'o', status: 'RENDERED', resource_version: 1, resource_id: 'v1', version_id: 'v1', sha256: 'b'.repeat(64), page_count: 2, watermarked: true };
    return { operation_id: 'o', status: 'DRAFT', resource_version: 4, resource_id: DOC_ID };
  };
  const h = harness(read, command);
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn(async () => [{ id: UNIT, code: 'DEPT-2', name: 'Department of Planning' }]);
  return h;
}

const open = (h: Harness, permissions: readonly string[] = ALL, path = `/?doc=${DOC_ID}`) => mount(<OutgoingEditorScreen route={ROUTE} />, h, permissions, path);
const label = (key: string) => screen.getByLabelText(vi_[key as keyof typeof vi_]) as HTMLInputElement;
const button = (key: string) => screen.getByRole('button', { name: vi_[key as keyof typeof vi_] });

afterEach(cleanup);

describe('OutgoingEditorScreen (DOC-02)', () => {
  describe('a new draft', () => {
    it('is composed from the template in force: the type, the unit, the content by parameter and the recipients go to createOutgoingDocument', async () => {
      const h = world();
      open(h, ALL, '/');
      const user = userEvent.setup();
      expect(await screen.findByRole('option', { name: 'QD' })).toBeTruthy();
      await screen.findByRole('option', { name: /DEPT-2/ });
      await user.selectOptions(label('doc.editor.type.label'), 'QD');
      expect(label('doc.editor.template.label').value).toBe('QD-DEFAULT');
      // A template that waits for legal confirmation says so before anything is previewed.
      expect(screen.getByText(vi_['doc.editor.template.watermark'])).toBeTruthy();
      await user.selectOptions(label('doc.editor.unit.label'), UNIT);
      await user.type(label('doc.editor.title.label'), '  Decision on the capital plan ');
      await user.type(label('doc.editor.field.agency'), 'People Committee');
      await user.type(label('doc.editor.field.place'), 'Cao Bang');
      await user.type(label('doc.editor.field.amount'), '6000000000');
      // The placeholders of the body appear once the template is read.
      await user.type(await screen.findByLabelText(/^title/), 'Decision');
      await user.type(screen.getByLabelText(/^body/), 'The body');
      await user.type(screen.getByLabelText('content_blocks.annex'), 'Annex 1');
      await user.click(button('doc.editor.recipient.add.action'));
      await user.type(screen.getByLabelText(vi_['doc.editor.recipient.name']), 'Department of Finance');
      await user.type(label('doc.editor.signer.label'), SIGNER.toUpperCase());
      await user.click(button('doc.editor.save.action'));
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('createOutgoingDocument', expect.anything()));
      const call = h.command.mock.calls.find((entry) => entry[0] === 'createOutgoingDocument');
      expect((call?.[1] as { body: unknown }).body).toEqual({
        doc_type_code: 'QD',
        template_code: 'QD-DEFAULT',
        title: 'Decision on the capital plan',
        drafting_unit_id: UNIT,
        urgency: 'NORMAL',
        circulation: 'INTERNAL_CIRCULATION',
        payload: { agency: 'People Committee', place: 'Cao Bang', amount_vnd: '6000000000', title: 'Decision', body: 'The body', content_blocks: { annex: 'Annex 1' } },
        recipients: [{ kind: 'EXTERNAL_AGENCY', name: 'Department of Finance' }],
        signing_mode: 'DIRECT',
        signer_user_id: SIGNER,
      });
    });

    it('marks what the form refuses before any request: the type, the unit, the summary, the amount, the signer and a delegation', async () => {
      const h = world();
      open(h, ALL, '/');
      const user = userEvent.setup();
      await screen.findByRole('option', { name: 'QD' });
      await user.type(label('doc.editor.title.label'), 'ab');
      await user.type(label('doc.editor.field.amount'), '12.5');
      await user.type(label('doc.editor.signer.label'), 'not-an-id');
      await user.selectOptions(label('doc.editor.mode.label'), 'TUQ');
      await user.click(button('doc.editor.recipient.add.action'));
      await user.click(button('doc.editor.save.action'));
      expect(screen.getAllByText(vi_['doc.draft.field.required']).length).toBeGreaterThanOrEqual(3);
      expect(screen.getByText(vi_['doc.draft.field.tooShort'])).toBeTruthy();
      expect(screen.getAllByText(vi_['doc.draft.field.invalid']).length).toBe(2);
      expect(screen.getByText(vi_['doc.draft.field.delegationRequired'])).toBeTruthy();
      expect(label('doc.editor.title.label').getAttribute('aria-invalid')).toBe('true');
      expect(h.command).not.toHaveBeenCalled();
      // A direct signature names no delegation.
      await user.selectOptions(label('doc.editor.mode.label'), 'DIRECT');
      await user.type(label('doc.editor.delegation.label'), SIGNER);
      expect(await screen.findByText(vi_['doc.draft.field.delegationNotAllowed'])).toBeTruthy();
    });

    it('chooses the default template of the document type and lists only the templates of that type', async () => {
      open(world(), ALL, '/');
      const user = userEvent.setup();
      await screen.findByRole('option', { name: 'CV' });
      await user.selectOptions(label('doc.editor.type.label'), 'CV');
      expect(label('doc.editor.template.label').value).toBe('CV-DEFAULT');
      expect(screen.queryByRole('option', { name: /QD-DEFAULT/ })).toBeNull();
      expect(screen.queryByText(vi_['doc.editor.template.watermark'])).toBeNull();
    });

    it('shows the refusal of a state secret with what to do, and keeps the draft', async () => {
      const h = world({ commands: { createOutgoingDocument: problem('STATE_SECRET_NOT_SUPPORTED', 422, {}, 'payload.secrecy_level') } });
      open(h, ALL, '/');
      const user = userEvent.setup();
      await screen.findByRole('option', { name: 'QD' });
      await screen.findByRole('option', { name: /DEPT-2/ });
      await user.selectOptions(label('doc.editor.type.label'), 'QD');
      await user.selectOptions(label('doc.editor.unit.label'), UNIT);
      await user.type(label('doc.editor.title.label'), 'A secret decision');
      await user.click(button('doc.editor.save.action'));
      const alert = await screen.findByRole('alert');
      expect(within(alert).getByText(vi_['doc.draft.problem.stateSecret'])).toBeTruthy();
      expect(within(alert).getByText(vi_['doc.editor.secret.hint'])).toBeTruthy();
      expect(label('doc.editor.title.label').value).toBe('A secret decision');
    });
  });

  describe('an existing draft', () => {
    it('loads the stored content into the form, with the template it was made from', async () => {
      open(world({ doc: detail() }));
      expect(await screen.findByDisplayValue('Decision on the capital plan')).toBeTruthy();
      expect(label('doc.editor.field.agency').value).toBe('People Committee');
      expect(label('doc.editor.field.amount').value).toBe('1000');
      expect(label('doc.editor.signer.label').value).toBe(SIGNER);
      expect(await screen.findByLabelText('content_blocks.annex')).toBeTruthy();
      expect((screen.getByLabelText('content_blocks.annex') as HTMLInputElement).value).toBe('Annex 1');
      expect((screen.getByDisplayValue('Department of Finance') as HTMLInputElement).value).toBe('Department of Finance');
      expect(label('doc.editor.type.label').disabled).toBe(true);
      expect(screen.getByText(fill(vi_['doc.editor.hash.text'], { sha: 'a'.repeat(16) }))).toBeTruthy();
    });

    it('saves under the version it read and says so', async () => {
      const h = world({ doc: detail() });
      open(h);
      const user = userEvent.setup();
      const title = await screen.findByDisplayValue('Decision on the capital plan');
      await user.clear(title);
      await user.type(title, 'A better title');
      await user.click(button('doc.editor.save.action'));
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('updateOutgoingDocumentDraft', expect.objectContaining({ ifMatchVersion: 3, path: { id: DOC_ID } })));
      expect(await screen.findByText(vi_['doc.editor.saved.notice'])).toBeTruthy();
      const body = (h.command.mock.calls.find((entry) => entry[0] === 'updateOutgoingDocumentDraft')?.[1] as { body: Record<string, unknown> }).body;
      expect(body).toMatchObject({ title: 'A better title', urgency: 'KHAN', signing_mode: 'DIRECT', signer_user_id: SIGNER });
      // The next save uses the version the server answered with.
      await user.type(title, '!');
      await user.click(button('doc.editor.save.action'));
      await waitFor(() => expect(h.command).toHaveBeenLastCalledWith('updateOutgoingDocumentDraft', expect.objectContaining({ ifMatchVersion: 4 })));
    });

    it('offers the reload of the document when another editor was first', async () => {
      const h = world({ doc: detail(), commands: { updateOutgoingDocumentDraft: problem('VERSION_CONFLICT', 409) } });
      open(h);
      const user = userEvent.setup();
      const title = await screen.findByDisplayValue('Decision on the capital plan');
      await user.type(title, '!');
      await user.click(button('doc.editor.save.action'));
      expect(await screen.findByText(vi_['doc.draft.problem.conflict'])).toBeTruthy();
      const reads = h.read.mock.calls.filter((entry) => entry[0] === 'getOutgoingDocument').length;
      await user.click(button('doc.editor.reload.action'));
      await waitFor(() => expect(h.read.mock.calls.filter((entry) => entry[0] === 'getOutgoingDocument').length).toBeGreaterThan(reads));
      await waitFor(() => expect((label('doc.editor.title.label') as HTMLInputElement).value).toBe('Decision on the capital plan'));
    });

    it('sends the saved draft for review, and not before the changes are saved', async () => {
      const h = world({ doc: detail() });
      open(h);
      const user = userEvent.setup();
      const title = await screen.findByDisplayValue('Decision on the capital plan');
      await user.type(title, '!');
      expect((button('doc.editor.submit.action') as HTMLButtonElement).disabled).toBe(true);
      expect(button('doc.editor.submit.action').getAttribute('title')).toBe(vi_['doc.editor.submit.unsaved']);
      await user.click(button('doc.editor.save.action'));
      await screen.findByText(vi_['doc.editor.saved.notice']);
      await user.click(button('doc.editor.submit.action'));
      await waitFor(() => expect(h.command).toHaveBeenLastCalledWith('submitOutgoingDocumentForReview', expect.objectContaining({ ifMatchVersion: 4, path: { id: DOC_ID } })));
    });

    it('lists what failed the checks by field when the draft cannot go to review (AC-ST-DOC-007-2)', async () => {
      const failures = [
        { field: 'recipients', code: 'RECIPIENTS_REQUIRED' },
        { field: 'signer_user_id', code: 'SIGNER_REQUIRED' },
        { field: 'payload.place', code: 'PAYLOAD_FIELD_REQUIRED' },
      ];
      const h = world({ doc: detail(), commands: { submitOutgoingDocumentForReview: problem('FORMAT_CHECK_FAILED', 422, { failures }) } });
      open(h);
      await userEvent.setup().click(await screen.findByRole('button', { name: vi_['doc.editor.submit.action'] }));
      const alert = await screen.findByRole('alert');
      expect(within(alert).getByText(vi_['doc.draft.problem.formatCheck'])).toBeTruthy();
      expect(within(alert).getByText(vi_['doc.draft.failure.recipients'])).toBeTruthy();
      expect(within(alert).getByText(vi_['doc.draft.failure.signer'])).toBeTruthy();
      expect(within(alert).getByText(fill(vi_['doc.draft.failure.field'], { field: 'place' }))).toBeTruthy();
    });

    it('explains a signer who is not authorised with the band that decided (AC-ST-DOC-007-1)', async () => {
      const threshold = { document_type: 'QD', amount_vnd: '6000000000', amount_min_vnd: '5000000000', amount_max_vnd: null, approver_role_id: 'r' };
      const h = world({ doc: detail(), commands: { submitOutgoingDocumentForReview: problem('SIGNER_NOT_AUTHORIZED', 422, { reason: 'ROLE_NOT_HELD', threshold }) } });
      open(h);
      await userEvent.setup().click(await screen.findByRole('button', { name: vi_['doc.editor.submit.action'] }));
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain(vi_['doc.draft.authority.role']);
      expect(alert.textContent).toContain(fill(vi_['doc.draft.authority.band'], { min: '5.000.000.000', max: vi_['doc.draft.authority.noLimit'] }));
    });

    it('is closed once the document is in review: nothing to save, a way to the review', async () => {
      open(world({ doc: detail({ status: 'IN_REVIEW', version: 5 }) }));
      expect(await screen.findByText(fill(vi_['doc.editor.locked.notice'], { status: vi_['doc.draft.status.inReview'] }))).toBeTruthy();
      expect(screen.queryByRole('button', { name: vi_['doc.editor.save.action'] })).toBeNull();
      expect(screen.queryByRole('button', { name: vi_['doc.editor.submit.action'] })).toBeNull();
      expect(label('doc.editor.title.label').matches(':disabled')).toBe(true);
      expect((screen.getByRole('link', { name: vi_['doc.editor.locked.review'] }) as HTMLAnchorElement).getAttribute('href')).toBe(`/doc/doc-04?doc=${DOC_ID}`);
    });

    it('shows why a draft was returned', async () => {
      const review = { kind: 'RETURNED', actor_id: SIGNER, comment: 'The recipients are incomplete', checklist: null, file_sha256: null, occurred_at: '2026-10-23T04:00:00.000Z' };
      open(world({ doc: detail({ latest_review: review }) }));
      expect(await screen.findByText('The recipients are incomplete')).toBeTruthy();
      expect(screen.getByText(vi_['doc.editor.returned.title'])).toBeTruthy();
    });

    it('cancels a draft with a reason and a code, after the reason is long enough', async () => {
      const h = world({ doc: detail() });
      open(h);
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: vi_['doc.editor.cancel.action'] }));
      await user.type(label('doc.editor.cancel.reason.label'), 'short');
      await user.click(button('doc.editor.cancel.confirm.action'));
      expect(await screen.findByText(vi_['doc.draft.field.tooShort'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
      await user.selectOptions(label('doc.editor.cancel.code.label'), 'SUPERSEDED_BEFORE_ISSUE');
      await user.type(label('doc.editor.cancel.reason.label'), ' reason that is long enough');
      await user.click(button('doc.editor.cancel.confirm.action'));
      await waitFor(() =>
        expect(h.command).toHaveBeenCalledWith('cancelOutgoingDocument', expect.objectContaining({ ifMatchVersion: 3, body: { reason: 'short reason that is long enough', reject_code: 'SUPERSEDED_BEFORE_ISSUE' } })),
      );
      expect(await screen.findByText(vi_['doc.editor.cancelled.notice'])).toBeTruthy();
    });

    it('tells a cancelled document and its reason, and offers no change', async () => {
      open(world({ doc: detail({ status: 'CANCELLED', cancel_reason: 'No longer needed' }) }));
      expect(await screen.findByText('No longer needed')).toBeTruthy();
      expect(screen.queryByRole('button', { name: vi_['doc.editor.cancel.action'] })).toBeNull();
      expect(screen.queryByRole('button', { name: vi_['doc.editor.save.action'] })).toBeNull();
    });
  });

  describe('the preview', () => {
    it('renders the draft with the summary and the recipients of the form and opens the file by its short-lived address', async () => {
      const h = world({ doc: detail() });
      open(h);
      const user = userEvent.setup();
      await screen.findByDisplayValue('Decision on the capital plan');
      await screen.findByLabelText('content_blocks.annex');
      await user.click(button('doc.editor.preview.action'));
      const card = await screen.findByText(vi_['doc.editor.preview.title']);
      expect(card).toBeTruthy();
      const call = h.command.mock.calls.find((entry) => entry[0] === 'renderDocumentPreview');
      expect((call?.[1] as { body: Record<string, unknown> }).body).toMatchObject({
        template_code: 'QD-DEFAULT',
        output: 'PDF',
        payload: { agency: 'People Committee', summary: 'Decision on the capital plan', recipients: ['Department of Finance'] },
      });
      expect(await screen.findByText(vi_['doc.editor.preview.watermarked'])).toBeTruthy();
      expect(screen.getByText(fill(vi_['doc.editor.preview.facts'], { pages: 2, sha: 'b'.repeat(16) }))).toBeTruthy();
      expect((screen.getByRole('link', { name: vi_['doc.editor.preview.open'] }) as HTMLAnchorElement).getAttribute('href')).toBe('mock://documents/preview?expires=1');
    });

    it('says so when the caller may not download the preview it rendered', async () => {
      const h = world({ doc: detail() });
      const download = h.read.getMockImplementation();
      h.read.mockImplementation((operation: string, input: unknown) => (operation === 'getDocumentVersionDownload' ? Promise.reject(problem('SCOPE_DENIED', 403)) : download?.(operation, input)));
      open(h);
      await screen.findByDisplayValue('Decision on the capital plan');
      await userEvent.setup().click(button('doc.editor.preview.action'));
      expect(await screen.findByText(vi_['doc.editor.preview.noLink'])).toBeTruthy();
      expect(screen.queryByRole('link', { name: vi_['doc.editor.preview.open'] })).toBeNull();
    });

    it('shows the refusal of the render and leaves the form as it was', async () => {
      const h = world({ doc: detail(), commands: { renderDocumentPreview: problem('PAYLOAD_SCHEMA_INVALID', 422) } });
      open(h);
      await screen.findByDisplayValue('Decision on the capital plan');
      await userEvent.setup().click(button('doc.editor.preview.action'));
      expect(await screen.findByText(vi_['doc.draft.problem.payload'])).toBeTruthy();
    });

    it('is not offered to a caller who may not render, and waits for a template on a new draft', async () => {
      open(world({ doc: detail() }), ['doc.outgoing.read', 'doc.outgoing.edit']);
      await screen.findByDisplayValue('Decision on the capital plan');
      expect(screen.queryByRole('button', { name: vi_['doc.editor.preview.action'] })).toBeNull();
      cleanup();
      open(world(), ALL, '/');
      await screen.findByRole('option', { name: 'QD' });
      expect((button('doc.editor.preview.action') as HTMLButtonElement).disabled).toBe(true);
    });
  });

  describe('permissions and the suspended tenant', () => {
    it('lets a reader see the draft and nothing else', async () => {
      open(world({ doc: detail() }), ['doc.outgoing.read']);
      await screen.findByDisplayValue('Decision on the capital plan');
      expect(screen.queryByRole('button', { name: vi_['doc.editor.save.action'] })).toBeNull();
      expect(screen.queryByRole('button', { name: vi_['doc.editor.submit.action'] })).toBeNull();
      expect(screen.queryByRole('button', { name: vi_['doc.editor.cancel.action'] })).toBeNull();
      expect(label('doc.editor.title.label').matches(':disabled')).toBe(true);
    });

    it('offers each step only to the holder of its permission', async () => {
      open(world({ doc: detail() }), ['doc.outgoing.read', 'doc.outgoing.edit', 'doc.outgoing.submit']);
      await screen.findByDisplayValue('Decision on the capital plan');
      expect(screen.getByRole('button', { name: vi_['doc.editor.save.action'] })).toBeTruthy();
      expect(screen.getByRole('button', { name: vi_['doc.editor.submit.action'] })).toBeTruthy();
      expect(screen.queryByRole('button', { name: vi_['doc.editor.cancel.action'] })).toBeNull();
    });

    it('offers nothing to anybody while the tenant is suspended', async () => {
      mountInSession(<OutgoingEditorScreen route={ROUTE} />, world({ doc: detail() }), { permissions: ALL, mode: 'READ_ONLY' }, `/?doc=${DOC_ID}`);
      await screen.findByDisplayValue('Decision on the capital plan');
      expect(screen.getByText(vi_['doc.editor.frozen.notice'])).toBeTruthy();
      expect(screen.queryByRole('button', { name: vi_['doc.editor.save.action'] })).toBeNull();
      expect(screen.queryByRole('button', { name: vi_['doc.editor.submit.action'] })).toBeNull();
    });

    it('starts over when the tenant changes: the form of the first tenant never reaches the second', async () => {
      const h = world();
      const view = mountInSession(<OutgoingEditorScreen route={ROUTE} />, h, { permissions: ALL, tenant: TENANT });
      const user = userEvent.setup();
      await user.type(await screen.findByLabelText(vi_['doc.editor.title.label']), 'Typed in the first tenant');
      view.rerenderWith({ permissions: ALL, tenant: SECOND_TENANT });
      await waitFor(() => expect((screen.getByLabelText(vi_['doc.editor.title.label']) as HTMLInputElement).value).toBe(''));
    });
  });

  describe('UI-DOC-02: the standard states', () => {
    it.each([
      ['denied', problem('SCOPE_DENIED', 403), vi_['states.denied.title']],
      ['offline', new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), vi_['states.offline.title']],
      ['error', problem('INTERNAL_ERROR', 500), vi_['states.error.title']],
      ['signed out', problem('SESSION_EXPIRED', 401), vi_['states.signedOut.title']],
    ])('UI-DOC-02: shows the %s state of a draft that cannot be read', async (_name, reply, title) => {
      open(world({ doc: reply }));
      expect(await screen.findByText(title)).toBeTruthy();
    });

    it('UI-DOC-02: shows the loading state first and names the page and the form for assistive technology', async () => {
      mount(<OutgoingEditorScreen route={ROUTE} />, harness(() => new Promise(() => undefined)), ALL, `/?doc=${DOC_ID}`);
      expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
      expect(screen.getByRole('region', { name: vi_['doc.editor.page.title'] })).toBeTruthy();
    });

    it('UI-DOC-02: gives every field and every action of the loaded form an accessible name', async () => {
      open(world({ doc: detail() }));
      await screen.findByDisplayValue('Decision on the capital plan');
      expect(screen.getByRole('form', { name: vi_['doc.editor.form.label'] })).toBeTruthy();
      for (const control of [...screen.getAllByRole('textbox'), ...screen.getAllByRole('combobox')]) expect((control as HTMLInputElement).labels?.length).toBeGreaterThan(0);
      for (const action of screen.getAllByRole('button')) expect((action.getAttribute('aria-label') ?? action.textContent ?? '').trim().length).toBeGreaterThan(0);
    });

    it('UI-DOC-02: retries the read of the draft after an error', async () => {
      let failing = true;
      const good = world({ doc: detail() });
      const h = harness((operation, input) => (operation === 'getOutgoingDocument' && failing ? problem('INTERNAL_ERROR', 500) : (good.read as unknown as (o: string, i: unknown) => unknown)(operation, input)));
      (h.client as unknown as { readAll: unknown }).readAll = vi.fn(async () => []);
      mount(<OutgoingEditorScreen route={ROUTE} />, h, ALL, `/?doc=${DOC_ID}`);
      expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
      failing = false;
      await userEvent.setup().click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
      expect(await screen.findByDisplayValue('Decision on the capital plan')).toBeTruthy();
    });
  });
});
