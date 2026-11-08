import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DocumentTemplatesScreen from '../DocumentTemplatesScreen';
import { harness, mount, mountInSession, routeOf } from '../test-support';
import type { Harness } from '../test-support';
import { EMPTY_CREATE, createBody, jsonObjectOf, refusalOfCreate, validateCreate } from './create-rules';
import type { CreateValues } from './create-rules';

const ROUTE = routeOf('DOC-14', 'FR-DOC-14');
const MANAGER = ['doc.template.read', 'doc.template.manage'];
const READER = ['doc.template.read'];
const LAYOUT = '00000000-0000-4000-8000-0000000000a1';
const OK = { operation_id: 'o', status: 'DRAFT', resource_version: 1, resource_id: 'x' };

const good: CreateValues = {
  ...EMPTY_CREATE,
  templateCode: 'MNE-TT44-M09',
  groupCode: 'REPORT_MONITORING',
  docTypeCode: 'BC',
  title: 'Monitoring report M09',
  layoutProfileId: LAYOUT,
  legalBasis: 'Circular 44/2026/TT-BTC',
  effectiveFrom: '2026-12-01',
};

describe('the rules of the template draft form', () => {
  it('accepts a sound form and builds the body without blank optional members', () => {
    expect(validateCreate(good)).toEqual({});
    expect(createBody({ ...good, formCode: ' M09 ', bodyBlocks: '{"blocks":[1]}', effectiveUntil: '2027-01-01' })).toEqual({
      template_code: 'MNE-TT44-M09',
      group_code: 'REPORT_MONITORING',
      doc_type_code: 'BC',
      title: 'Monitoring report M09',
      layout_profile_id: LAYOUT,
      body_blocks: { blocks: [1] },
      placeholder_schema: {},
      legal_basis: 'Circular 44/2026/TT-BTC',
      effective_from: '2026-12-01',
      form_code: 'M09',
      effective_until: '2027-01-01',
    });
  });

  it('marks every required member and every length of the schema', () => {
    const found = validateCreate(EMPTY_CREATE);
    expect(Object.keys(found).sort()).toEqual(['docTypeCode', 'effectiveFrom', 'groupCode', 'layoutProfileId', 'legalBasis', 'templateCode', 'title']);
    expect(validateCreate({ ...good, templateCode: 'ab' }).templateCode).toBe('tooShort');
    expect(validateCreate({ ...good, templateCode: 'x'.repeat(81) }).templateCode).toBe('tooLong');
    expect(validateCreate({ ...good, docTypeCode: 'x'.repeat(21) }).docTypeCode).toBe('tooLong');
    expect(validateCreate({ ...good, sourceModule: 'M' }).sourceModule).toBe('tooShort');
    expect(validateCreate({ ...good, watermarkText: 'ab' }).watermarkText).toBe('tooShort');
    expect(validateCreate({ ...good, legalConfirmationRef: 'x'.repeat(51) }).legalConfirmationRef).toBe('tooLong');
    expect(validateCreate({ ...good, legalBasis: 'x'.repeat(2001) }).legalBasis).toBe('tooLong');
  });

  it('wants JSON objects in the two JSON members, and a real period', () => {
    expect(validateCreate({ ...good, bodyBlocks: 'not json' }).bodyBlocks).toBe('notJson');
    expect(validateCreate({ ...good, placeholderSchema: '[1]' }).placeholderSchema).toBe('notObject');
    expect(jsonObjectOf('null')).toEqual({ ok: false, problem: 'notObject' });
    expect(validateCreate({ ...good, effectiveFrom: '2026-02-30' }).effectiveFrom).toBe('badDay');
    expect(validateCreate({ ...good, effectiveUntil: '2026-11-30' }).effectiveUntil).toBe('beforeStart');
    expect(validateCreate({ ...good, effectiveUntil: 'x' }).effectiveUntil).toBe('badDay');
  });

  it('tells the codes the operation names apart', () => {
    expect(['LEGAL_BASIS_REQUIRED', 'PLACEHOLDER_SCHEMA_INVALID', 'FORM_CODE_DUPLICATE', 'TEMPLATE_RANGE_OVERLAP', 'VALIDATION_FAILED', 'SCOPE_DENIED', 'SESSION_EXPIRED', 'X', undefined].map(refusalOfCreate)).toEqual([
      'legalBasis',
      'placeholders',
      'formDuplicate',
      'overlap',
      'invalid',
      'denied',
      'session',
      'other',
      'other',
    ]);
  });
});

function open(command: (operation: string, input: unknown) => unknown = () => OK, layouts: unknown[] | Error = [{ id: LAYOUT, profile_code: 'ND30_A4', revision: 2, status: 'PUBLISHED' }, { id: 'draft', profile_code: 'ND30_A4', revision: 3, status: 'DRAFT' }]): Harness {
  const h = harness((operation) => (operation === 'listDocumentTemplates' ? { items: [], next_cursor: null } : new Error('unexpected read')), command);
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn(() => (layouts instanceof Error ? Promise.reject(layouts) : Promise.resolve(layouts)));
  return h;
}

const type = (id: string, value: string) => fireEvent.change(document.getElementById(id) as HTMLElement, { target: { value } });
async function fillGood(): Promise<void> {
  await waitFor(() => expect(within(document.getElementById('tpl-layoutProfileId') as HTMLElement).getByText(/ND30_A4/)).toBeTruthy());
  type('tpl-templateCode', 'MNE-TT44-M09');
  type('tpl-groupCode', 'REPORT_MONITORING');
  type('tpl-docTypeCode', 'BC');
  type('tpl-title', 'Monitoring report M09');
  type('tpl-layoutProfileId', LAYOUT);
  type('tpl-legalBasis', 'Circular 44/2026/TT-BTC');
  type('tpl-effectiveFrom', '2026-12-01');
}

afterEach(cleanup);

describe('DOC-14 drafting a revision of a template', () => {
  it('offers the action only to a person who may manage templates, and not in a suspended tenant', async () => {
    mount(<DocumentTemplatesScreen route={ROUTE} />, open(), READER);
    await screen.findByText(ROUTE.id, { exact: false });
    expect(screen.queryByTestId('template-create-open')).toBeNull();
    cleanup();
    mountInSession(<DocumentTemplatesScreen route={ROUTE} />, open(), { permissions: MANAGER, mode: 'READ_ONLY' });
    await screen.findByText(ROUTE.id, { exact: false });
    expect(screen.queryByTestId('template-create-open')).toBeNull();
  });

  it('offers only published layouts, checks the form before sending, and sends nothing while it has problems', async () => {
    const h = open();
    mount(<DocumentTemplatesScreen route={ROUTE} />, h, MANAGER);
    fireEvent.click(await screen.findByTestId('template-create-open'));
    await waitFor(() => expect((document.getElementById('tpl-layoutProfileId') as HTMLSelectElement).options.length).toBe(2));
    fireEvent.submit(screen.getByTestId('template-create-form'));
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(3);
    type('tpl-bodyBlocks', 'oops');
    fireEvent.submit(screen.getByTestId('template-create-form'));
    expect(h.command).not.toHaveBeenCalled();
    expect(document.querySelector('.ui-info__button')).not.toBeNull();
  });

  it('sends the draft once under its idempotency attempt, closes the form and says it is a draft', async () => {
    const h = open();
    mount(<DocumentTemplatesScreen route={ROUTE} />, h, MANAGER);
    fireEvent.click(await screen.findByTestId('template-create-open'));
    await fillGood();
    type('tpl-formCode', 'M09');
    fireEvent.submit(screen.getByTestId('template-create-form'));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command).toHaveBeenCalledWith(
      'createDocumentTemplateRevision',
      expect.objectContaining({ body: expect.objectContaining({ template_code: 'MNE-TT44-M09', group_code: 'REPORT_MONITORING', layout_profile_id: LAYOUT, form_code: 'M09', body_blocks: {}, placeholder_schema: {} }) }),
    );
    await waitFor(() => expect(screen.queryByTestId('template-create-form')).toBeNull());
    expect(screen.getAllByRole('status').some((node) => (node.textContent ?? '').includes('MNE-TT44-M09'))).toBe(true);
  });

  it.each([
    ['LEGAL_BASIS_REQUIRED', 422, 'legalBasis'],
    ['PLACEHOLDER_SCHEMA_INVALID', 422, 'placeholders'],
    ['FORM_CODE_DUPLICATE', 409, 'formDuplicate'],
    ['TEMPLATE_RANGE_OVERLAP', 409, 'overlap'],
  ])('says in words what the server refused (%s) and keeps what was typed', async (code, status, kind) => {
    const h = open(() => new ApiError({ status, code, correlationId: 'c' }));
    mount(<DocumentTemplatesScreen route={ROUTE} />, h, MANAGER);
    fireEvent.click(await screen.findByTestId('template-create-open'));
    await fillGood();
    fireEvent.submit(screen.getByTestId('template-create-form'));
    const error = await screen.findByTestId('template-create-error');
    expect(error.getAttribute('data-refusal')).toBe(kind);
    expect((document.getElementById('tpl-templateCode') as HTMLInputElement).value).toBe('MNE-TT44-M09');
  });

  it('says the layouts could not be loaded, with a retry, and when none is published', async () => {
    mount(<DocumentTemplatesScreen route={ROUTE} />, open(() => OK, new Error('down')), MANAGER);
    fireEvent.click(await screen.findByTestId('template-create-open'));
    expect(await screen.findByTestId('layout-error')).toBeTruthy();
    cleanup();
    mount(<DocumentTemplatesScreen route={ROUTE} />, open(() => OK, []), MANAGER);
    fireEvent.click(await screen.findByTestId('template-create-open'));
    await waitFor(() => expect((document.getElementById('tpl-layoutProfileId') as HTMLSelectElement).disabled).toBe(false));
    expect(screen.queryByTestId('layout-error')).toBeNull();
  });

  it('closes on cancel without sending', async () => {
    const h = open();
    mount(<DocumentTemplatesScreen route={ROUTE} />, h, MANAGER);
    fireEvent.click(await screen.findByTestId('template-create-open'));
    fireEvent.click(screen.getByTestId('template-create-cancel'));
    expect(screen.queryByTestId('template-create-form')).toBeNull();
    expect(h.command).not.toHaveBeenCalled();
  });
});
