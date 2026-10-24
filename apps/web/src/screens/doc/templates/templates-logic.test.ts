import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { actionsFor, cxnTags, matchesText } from './model';
import type { ActionContext } from './model';
import { describeProblem } from './problems';
import { confirmationBody, reasonProblem, validateConfirmation } from './rules';
import { toTemplate, toTemplatePage } from './types';
import type { Template } from './types';

const ME = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-0000000000aa';
const THIRD = '00000000-0000-4000-8000-0000000000bb';

const template = (overrides: Partial<Template> = {}): Template => ({
  ...toTemplate({ id: 'x', template_code: 'T-1', revision: 1, status: 'PUBLISHED', confirmation_status: 'PENDING_CONFIRMATION', created_by: OTHER, approved_by: THIRD, version: 2 }),
  ...overrides,
});

const context = (permissions: readonly string[] | undefined, overrides: Partial<ActionContext> = {}): ActionContext => ({
  membershipId: ME,
  permissions,
  frozen: false,
  manage: 'doc.template.manage',
  approve: 'doc.template.approve',
  confirmLegal: 'doc.template.confirm_legal',
  ...overrides,
});

describe('toTemplate', () => {
  it('reads a row of the list, and falls back for what the server does not say', () => {
    const row = toTemplate({
      id: 'a',
      template_code: 'MNE-TT44-M02',
      revision: 3,
      group_code: 'REPORT_MONITORING',
      doc_type_code: 'BC',
      form_code: 'M02',
      title: 'Report',
      source_module: 'MNE',
      legal_basis: 'TT 44/2026 [CXN-10]',
      legal_confirmation_ref: 'CXN-10',
      confirmation_status: 'CONFIRMED',
      watermark_text: 'wm',
      cxn_refs: ['CXN-10', 7],
      origin: 'TENANT',
      pack_version: null,
      layout_confirmation_status: 'PENDING_CONFIRMATION',
      renders_watermarked: true,
      effective_from: '2026-01-01',
      effective_until: '2027-01-01',
      status: 'RETIRED',
      version: 4,
      created_by: OTHER,
      approved_by: THIRD,
    });
    expect(row).toMatchObject({ revision: 3, formCode: 'M02', cxnRefs: ['CXN-10'], origin: 'TENANT', layoutConfirmationStatus: 'PENDING_CONFIRMATION', rendersWatermarked: true, status: 'RETIRED', version: 4 });
    const bare = toTemplate(null);
    expect(bare).toMatchObject({ id: '', groupCode: 'OTHER', status: 'DRAFT', origin: 'PLATFORM_PACK', confirmationStatus: 'PENDING_CONFIRMATION', layoutConfirmationStatus: null, rendersWatermarked: true, cxnRefs: [], formCode: null, version: 0 });
    expect(toTemplate({ confirmation_status: 'CONFIRMED' }).rendersWatermarked).toBe(false);
    expect(toTemplate({ group_code: 'NOPE', status: 'NOPE', revision: Number.NaN }).groupCode).toBe('OTHER');
  });

  it('reads a page, and an answer that is not a page as an empty one', () => {
    expect(toTemplatePage({ items: [{ id: 'a' }], next_cursor: 'c' })).toMatchObject({ items: [{ id: 'a' }], nextCursor: 'c' });
    expect(toTemplatePage({ items: 'x', next_cursor: 5 })).toEqual({ items: [], nextCursor: undefined });
    expect(toTemplatePage(undefined)).toEqual({ items: [], nextCursor: undefined });
  });
});

describe('actionsFor', () => {
  const none = { publish: false, publishNeedsOther: false, confirm: false, confirmNeedsOther: false, retire: false };

  it('offers a draft for publication to an approver who did not draft it, and asks for another person when they did', () => {
    const draft = template({ status: 'DRAFT', approvedBy: null });
    expect(actionsFor(draft, context(['doc.template.approve']))).toEqual({ ...none, publish: true });
    expect(actionsFor({ ...draft, createdBy: ME.toUpperCase() }, context(['doc.template.approve']))).toEqual({ ...none, publishNeedsOther: true });
    expect(actionsFor(draft, context(['doc.template.manage']))).toEqual({ ...none, retire: true });
    expect(actionsFor(draft, context(['doc.template.read']))).toEqual(none);
  });

  it('offers the confirmation of a waiting published template to someone who neither drafted nor published it', () => {
    const waiting = template();
    expect(actionsFor(waiting, context(['doc.template.confirm_legal']))).toEqual({ ...none, confirm: true });
    expect(actionsFor({ ...waiting, createdBy: ME }, context(['doc.template.confirm_legal']))).toEqual({ ...none, confirmNeedsOther: true });
    expect(actionsFor({ ...waiting, approvedBy: ME }, context(['doc.template.confirm_legal']))).toEqual({ ...none, confirmNeedsOther: true });
    expect(actionsFor({ ...waiting, confirmationStatus: 'CONFIRMED' }, context(['doc.template.confirm_legal']))).toEqual(none);
    expect(actionsFor({ ...waiting, status: 'RETIRED' }, context(['doc.template.confirm_legal', 'doc.template.manage']))).toEqual(none);
  });

  it('knows nobody when the person is unknown, offers everything the server may then refuse when the grants are unknown, and nothing when frozen', () => {
    const draft = template({ status: 'DRAFT', approvedBy: null });
    expect(actionsFor(draft, context(['doc.template.approve'], { membershipId: undefined }))).toEqual({ ...none, publish: true });
    expect(actionsFor(draft, context(undefined))).toMatchObject({ publish: true, retire: true });
    expect(actionsFor(template(), context(undefined))).toMatchObject({ confirm: true, retire: true });
    expect(actionsFor(draft, context(['doc.template.approve', 'doc.template.manage'], { frozen: true }))).toEqual(none);
  });
});

describe('labels and filters', () => {
  it('shows the confirmations the text names, or the generic label', () => {
    expect(cxnTags(template({ cxnRefs: ['CXN-10', 'CXN-DOC-06'] }))).toBe('[CXN-10] [CXN-DOC-06]');
    expect(cxnTags(template({ cxnRefs: [] }))).toBe('[CXN]');
  });

  it('matches the text over the code, title, form, legal basis and module', () => {
    const row = template({ templateCode: 'MNE-TT44-M02', title: 'Monitoring report', formCode: 'M02', legalBasis: 'Circular 44', sourceModule: 'MNE' });
    for (const text of ['', '   ', 'mne-tt44', 'monitoring', 'm02', 'circular', 'MNE']) expect(matchesText(row, text)).toBe(true);
    expect(matchesText(row, 'treasury')).toBe(false);
    expect(matchesText(template({ formCode: null, sourceModule: null }), 'null')).toBe(false);
  });
});

describe('the forms', () => {
  const ok = { reference: 'CXN-10', evidenceDocumentId: '00000000-0000-4000-8000-0000000000e1', note: '' };

  it('accepts a reference of 3 to 50 characters, an evidence document id and a note up to 1000', () => {
    expect(validateConfirmation(ok)).toEqual({});
    expect(validateConfirmation({ ...ok, reference: 'abc', note: 'n'.repeat(1000) })).toEqual({});
    expect(validateConfirmation({ reference: ' ', evidenceDocumentId: '', note: '' })).toEqual({ reference: 'required', evidenceDocumentId: 'required' });
    expect(validateConfirmation({ ...ok, reference: 'ab', evidenceDocumentId: 'nope' })).toEqual({ reference: 'tooShort', evidenceDocumentId: 'uuid' });
    expect(validateConfirmation({ ...ok, reference: 'r'.repeat(51), note: 'n'.repeat(1001) })).toEqual({ reference: 'tooLong', note: 'tooLong' });
  });

  it('builds the body with trimmed text, a lower case id and the note only when there is one', () => {
    expect(confirmationBody({ reference: ' CXN-10 ', evidenceDocumentId: ' 00000000-0000-4000-8000-0000000000E1 ', note: '  ' })).toEqual({
      legal_confirmation_ref: 'CXN-10',
      evidence_document_id: '00000000-0000-4000-8000-0000000000e1',
    });
    expect(confirmationBody({ ...ok, note: ' checked ' })).toMatchObject({ note: 'checked' });
  });

  it('asks for a reason of 10 to 2000 characters', () => {
    expect(reasonProblem('')).toBe('required');
    expect(reasonProblem('too short')).toBe('tooShort');
    expect(reasonProblem('x'.repeat(2001))).toBe('tooLong');
    expect(reasonProblem('A reason that is long enough')).toBeUndefined();
  });
});

describe('describeProblem', () => {
  it('maps the codes of the commands and keeps the field the server named', () => {
    expect(describeProblem(new ApiError({ status: 403, code: 'SELF_APPROVAL_DENIED', correlationId: 'c' }))).toEqual({ reason: 'selfApproval', field: undefined });
    expect(describeProblem(new ApiError({ status: 422, code: 'VALIDATION_FAILED', detail: 'evidence_document_id', correlationId: 'c' }))).toEqual({ reason: 'invalid', field: 'evidence_document_id' });
    expect(describeProblem(new ApiError({ status: 500, code: 'WHO_KNOWS', correlationId: 'c' })).reason).toBe('general');
    expect(describeProblem(new Error('socket'))).toEqual({ reason: 'general', field: undefined });
  });
});
