import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { createTranslator } from '../../../i18n';
import en from '../../../i18n/en.json';
import vi_ from '../../../i18n/vi.json';
import { directionLabel, entryStatusLabel, fieldProblemMessage, modeLabel, problemMessage, statusLabel, symbolKindLabel } from './labels';
import { describeProblem } from './problems';
import type { ProblemReason } from './problems';
import {
  CLOSE_REASON_MIN,
  EMPTY_REGISTER_VALUES,
  EMPTY_TYPE_VALUES,
  closeReasonProblem,
  registerBody,
  symbolPatternProblem,
  typeBody,
  validateRegisterForm,
  validateTypeForm,
} from './rules';
import type { FieldProblem } from './rules';
import { toDocType, toEntry, toEntryPage, toRegister, toRegisterPage } from './types';

const t = createTranslator({ locale: 'vi', catalogues: { vi: vi_, en }, strict: true }).t;

const VALID_TYPE = { ...EMPTY_TYPE_VALUES, code: 'QD', name: 'Decision', symbolPattern: '{number}/{type}-{agency}', registerCode: 'REG-QD', legalBasis: 'ND 30/2020', effectiveFrom: '2026-01-01' };
const VALID_REGISTER = { ...EMPTY_REGISTER_VALUES, registerCode: 'REG-QD', name: 'Decisions', organizationUnitId: 'unit-1', year: '2026' };

describe('symbol pattern (BR-DOC-05)', () => {
  it.each([
    ['{number}/{type}-{agency}', undefined],
    ['{number}/{unit}', undefined],
    ['{number}', undefined],
    ['{type}-{agency}', 'pattern'],
    ['{number}/{number}', 'pattern'],
    ['{number}a/{type}', 'pattern'],
    ['{number}/{other}', 'pattern'],
    ['{number}/{type', 'pattern'],
    ['{number}/type}', 'pattern'],
  ])('judges %s', (pattern, expected) => {
    expect(symbolPatternProblem(pattern)).toBe(expected);
  });
});

describe('document type form', () => {
  it('accepts a complete form and builds the request body from trimmed values', () => {
    expect(validateTypeForm(VALID_TYPE)).toEqual({});
    expect(typeBody({ ...VALID_TYPE, code: ' QD ', abbreviation: ' Q ', effectiveUntil: '2027-01-01' })).toEqual({
      code: 'QD',
      name: 'Decision',
      abbreviation: 'Q',
      symbol_kind: 'DECISION',
      symbol_pattern: '{number}/{type}-{agency}',
      register_code: 'REG-QD',
      legal_basis: 'ND 30/2020',
      effective_from: '2026-01-01',
      effective_until: '2027-01-01',
    });
    expect(typeBody(VALID_TYPE)).not.toHaveProperty('abbreviation');
    expect(typeBody(VALID_TYPE)).not.toHaveProperty('effective_until');
  });

  it('names what is wrong with each field', () => {
    expect(validateTypeForm(EMPTY_TYPE_VALUES)).toEqual({
      code: 'required',
      name: 'required',
      registerCode: 'required',
      legalBasis: 'required',
      symbolPattern: 'required',
      effectiveFrom: 'required',
    });
    expect(validateTypeForm({ ...VALID_TYPE, name: 'ab', registerCode: 'x', symbolPattern: 'ab' })).toMatchObject({ name: 'tooShort', registerCode: 'tooShort', symbolPattern: 'tooShort' });
    expect(validateTypeForm({ ...VALID_TYPE, code: 'x'.repeat(21), abbreviation: 'y'.repeat(21) })).toMatchObject({ code: 'tooLong', abbreviation: 'tooLong' });
    expect(validateTypeForm({ ...VALID_TYPE, symbolPattern: '{number}a/{type}' })).toEqual({ symbolPattern: 'pattern' });
    expect(validateTypeForm({ ...VALID_TYPE, effectiveFrom: '01/01/2026' })).toEqual({ effectiveFrom: 'date' });
    expect(validateTypeForm({ ...VALID_TYPE, effectiveUntil: 'later' })).toEqual({ effectiveUntil: 'date' });
    expect(validateTypeForm({ ...VALID_TYPE, effectiveUntil: '2026-01-01' })).toEqual({ effectiveUntil: 'range' });
    expect(validateTypeForm({ ...VALID_TYPE, effectiveFrom: '', effectiveUntil: '2025-01-01' })).toEqual({ effectiveFrom: 'required' });
  });
});

describe('register form', () => {
  it('accepts a complete form and builds the body', () => {
    expect(validateRegisterForm(VALID_REGISTER)).toEqual({});
    expect(registerBody({ ...VALID_REGISTER, registerCode: ' REG ', scopeDocTypes: ['QD'] })).toEqual({
      register_code: 'REG',
      name: 'Decisions',
      direction: 'OUTGOING',
      organization_unit_id: 'unit-1',
      year: 2026,
      mode: 'MANAGED',
      scope_doc_types: ['QD'],
    });
  });

  it('names what is wrong with each field', () => {
    expect(validateRegisterForm(EMPTY_REGISTER_VALUES)).toEqual({ registerCode: 'required', name: 'required', organizationUnitId: 'required', year: 'required' });
    expect(validateRegisterForm({ ...VALID_REGISTER, year: '1999' })).toEqual({ year: 'year' });
    expect(validateRegisterForm({ ...VALID_REGISTER, year: '2026.5' })).toEqual({ year: 'year' });
    expect(validateRegisterForm({ ...VALID_REGISTER, year: 'abc' })).toEqual({ year: 'year' });
  });

  it('asks for a reason of at least ten characters when closing', () => {
    expect(closeReasonProblem('')).toBe('required');
    expect(closeReasonProblem('x'.repeat(CLOSE_REASON_MIN - 1))).toBe('tooShort');
    expect(closeReasonProblem('x'.repeat(501))).toBe('tooLong');
    expect(closeReasonProblem('x'.repeat(CLOSE_REASON_MIN))).toBeUndefined();
  });
});

describe('problems', () => {
  const api = (code: string, status: number, detail?: string) => new ApiError({ status, code, detail, correlationId: 'corr-1' });

  it.each([
    ['VERSION_CONFLICT', 409, 'conflict'],
    ['REGISTER_ALREADY_EXISTS', 409, 'registerExists'],
    ['REGISTER_NOT_OPEN', 409, 'notOpen'],
    ['REGISTER_HAS_OPEN_NUMBERED_DOCUMENTS', 409, 'hasNumbered'],
    ['DOC_TYPE_RANGE_OVERLAP', 409, 'rangeOverlap'],
    ['SYMBOL_PATTERN_INVALID', 409, 'patternInvalid'],
    ['VALIDATION_FAILED', 422, 'invalid'],
    ['INVALID_REQUEST', 400, 'invalid'],
    ['FIELD_NOT_ALLOWED', 400, 'invalid'],
    ['RESOURCE_NOT_FOUND', 404, 'notFound'],
    ['SCOPE_DENIED', 403, 'denied'],
    ['ENTITLEMENT_DENIED', 403, 'denied'],
    ['SESSION_EXPIRED', 401, 'session'],
    ['SOMETHING_ELSE', 500, 'general'],
  ] as const)('maps %s to %s', (code, status, reason) => {
    expect(describeProblem(api(code, status, 'year')).reason).toBe(reason);
  });

  it('keeps the field the server names and treats anything that is not an API error as general', () => {
    expect(describeProblem(api('VALIDATION_FAILED', 422, 'year'))).toEqual({ reason: 'invalid', field: 'year' });
    expect(describeProblem(new Error('x'))).toEqual({ reason: 'general', field: undefined });
  });

  it('has words for every reason and every form problem in both languages', () => {
    const reasons: ProblemReason[] = ['conflict', 'registerExists', 'notOpen', 'hasNumbered', 'rangeOverlap', 'patternInvalid', 'invalid', 'notFound', 'denied', 'session', 'general'];
    for (const reason of reasons) expect(problemMessage(t, { reason, field: undefined }).length).toBeGreaterThan(0);
    const problems: FieldProblem[] = ['required', 'tooShort', 'tooLong', 'date', 'range', 'pattern', 'year'];
    for (const problem of problems) expect(fieldProblemMessage(t, problem).length).toBeGreaterThan(0);
    expect(directionLabel(t, 'OUTGOING')).toBe(vi_['doc.registers.direction.outgoing']);
    expect(directionLabel(t, 'INCOMING')).toBe(vi_['doc.registers.direction.incoming']);
    expect(statusLabel(t, 'OPEN')).toBe(vi_['doc.registers.status.open']);
    expect(statusLabel(t, 'CLOSED')).toBe(vi_['doc.registers.status.closed']);
    expect(modeLabel(t, 'MANAGED')).toBe(vi_['doc.registers.mode.managed']);
    expect(modeLabel(t, 'MIRRORED')).toBe(vi_['doc.registers.mode.mirrored']);
    expect(entryStatusLabel(t, 'ALLOCATED')).toBe(vi_['doc.registers.entryStatus.allocated']);
    expect(entryStatusLabel(t, 'VOIDED')).toBe(vi_['doc.registers.entryStatus.voided']);
    expect(entryStatusLabel(t, 'RECALLED')).toBe(vi_['doc.registers.entryStatus.recalled']);
    expect(symbolKindLabel(t, 'DECISION')).toBe(vi_['doc.types.kind.decision']);
    expect(symbolKindLabel(t, 'NAMED_TYPE')).toBe(vi_['doc.types.kind.namedType']);
    expect(symbolKindLabel(t, 'OFFICIAL_LETTER')).toBe(vi_['doc.types.kind.officialLetter']);
  });
});

describe('parsing of the API answers', () => {
  it('reads a register and falls back on safe values for anything missing', () => {
    expect(
      toRegister({ id: 'r1', register_code: 'REG', name: 'N', direction: 'INCOMING', organization_unit_id: 'u', year: 2026, mode: 'MIRRORED', last_number: 4, status: 'CLOSED', scope_doc_types: ['QD', 7], version: 3 }),
    ).toEqual({ id: 'r1', registerCode: 'REG', name: 'N', direction: 'INCOMING', organizationUnitId: 'u', year: 2026, mode: 'MIRRORED', lastNumber: 4, nextNumber: 5, status: 'CLOSED', scopeDocTypes: ['QD'], version: 3 });
    expect(toRegister(null)).toMatchObject({ id: '', direction: 'OUTGOING', mode: 'MANAGED', status: 'OPEN', lastNumber: 0, nextNumber: 1, scopeDocTypes: [] });
    expect(toRegister({ last_number: 4, next_number: 9 }).nextNumber).toBe(9);
  });

  it('reads an entry, a type and the pages', () => {
    expect(toEntry({ allocation_id: 'a', number: 3, display_number: '03', symbol: '03/QD', document_id: 'd', issued_on: '2026-06-15', status: 'VOIDED' })).toEqual({
      allocationId: 'a',
      number: 3,
      displayNumber: '03',
      symbol: '03/QD',
      documentId: 'd',
      issuedOn: '2026-06-15',
      status: 'VOIDED',
    });
    expect(toEntry({ number: 12 })).toMatchObject({ displayNumber: '12', status: 'ALLOCATED' });
    expect(toEntry({ number: 5, status: 'RECALLED' })).toMatchObject({ displayNumber: '05', status: 'RECALLED' });
    expect(toDocType({ id: 't', code: 'QD', name: 'N', abbreviation: 'Q', symbol_kind: 'OFFICIAL_LETTER', symbol_pattern: 'p', register_code: 'R', effective_from: '2026-01-01', effective_until: null, status: 'PUBLISHED', version: 2 })).toMatchObject({
      symbolKind: 'OFFICIAL_LETTER',
      abbreviation: 'Q',
      effectiveUntil: null,
      version: 2,
    });
    expect(toDocType(undefined)).toMatchObject({ symbolKind: 'DECISION', abbreviation: null });
    expect(toRegisterPage({ items: [{ id: 'r' }], doc_types: [{ id: 't' }], next_cursor: 'c' })).toMatchObject({ nextCursor: 'c' });
    expect(toRegisterPage('x')).toEqual({ items: [], docTypes: [], nextCursor: undefined });
    expect(toEntryPage({ register: { id: 'r' }, items: [{ number: 1 }], next_cursor: null })).toMatchObject({ nextCursor: undefined, register: { id: 'r' } });
    expect(toEntryPage(null)).toEqual({ register: undefined, items: [], nextCursor: undefined });
  });
});
