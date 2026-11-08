import { describe, expect, it } from 'vitest';
import { EMPTY_ITEM, closeBody, dossierCreateBody, dossierCreateHasProblems, emptyDossierCreate, itemBody, itemHasProblems, ruleForClosing, validateDossierCreate, validateItem, validateSettlement } from './dossier-forms';
import type { RetentionRule } from './types';

const UNIT = '00000000-0000-4000-8000-0000000000b1';
const DOC = '00000000-0000-4000-8000-0000000000D1';
const good = { ...emptyDossierCreate(2026), dossierCode: 'DS-2026-01', title: 'Hồ sơ dự án', unitId: UNIT, categoryCode: 'PROJECT_INVESTMENT' };

describe('validateDossierCreate', () => {
  it('accepts a sound form and builds the body of the command', () => {
    expect(dossierCreateHasProblems(validateDossierCreate(good))).toBe(false);
    expect(dossierCreateBody({ ...good, dossierCode: ' DS-2026-01 ' })).toEqual({ dossier_code: 'DS-2026-01', year: 2026, title: 'Hồ sơ dự án', organization_unit_id: UNIT, category_code: 'PROJECT_INVESTMENT' });
  });
  it('wants the code, the title, the unit, the category and a year in range', () => {
    const found = validateDossierCreate({ ...good, dossierCode: 'ab', title: ' ', unitId: '', categoryCode: 'lower', year: '1999' });
    expect(found).toMatchObject({ dossierCode: 'tooShort', title: 'required', unitId: 'required', categoryCode: 'invalid', year: 'invalid' });
    expect(validateDossierCreate({ ...good, year: '' }).year).toBe('required');
    expect(validateDossierCreate({ ...good, dossierCode: 'x'.repeat(81) }).dossierCode).toBe('tooLong');
    expect(validateDossierCreate({ ...good, unitId: 'not-an-id' }).unitId).toBe('invalid');
  });
  it('takes the source module and the source id together or not at all', () => {
    expect(validateDossierCreate({ ...good, subjectModule: 'PRJ' }).subjectId).toBe('required');
    expect(validateDossierCreate({ ...good, subjectId: UNIT }).subjectModule).toBe('required');
    expect(validateDossierCreate({ ...good, subjectModule: 'P', subjectId: UNIT }).subjectModule).toBe('invalid');
    expect(dossierCreateBody({ ...good, subjectModule: 'PRJ', subjectId: UNIT.toUpperCase() })).toMatchObject({ subject_module: 'PRJ', subject_id: UNIT });
  });
});

describe('items and closing', () => {
  it('wants a document id and a positive whole position when one is given', () => {
    expect(itemHasProblems(validateItem(EMPTY_ITEM))).toBe(true);
    expect(validateItem({ documentId: 'x', ordinal: '' }).documentId).toBe('invalid');
    expect(validateItem({ documentId: DOC, ordinal: '0' }).ordinal).toBe('invalid');
    expect(validateItem({ documentId: DOC, ordinal: '1.5' }).ordinal).toBe('invalid');
    expect(itemBody({ documentId: ` ${DOC} `, ordinal: '3' })).toEqual({ document_id: DOC.toLowerCase(), ordinal: 3 });
    expect(itemBody({ documentId: DOC, ordinal: '' })).toEqual({ document_id: DOC.toLowerCase() });
  });
  it('takes a settlement day that is real and not after today', () => {
    expect(validateSettlement('', '2026-11-08')).toBeUndefined();
    expect(validateSettlement('2026-11-08', '2026-11-08')).toBeUndefined();
    expect(validateSettlement('2026-11-09', '2026-11-08')).toBe('invalid');
    expect(validateSettlement('2026-02-30', '2026-11-08')).toBe('invalid');
    expect(closeBody('')).toEqual({});
    expect(closeBody('2026-10-01')).toEqual({ settlement_closed_on: '2026-10-01' });
  });
});

describe('ruleForClosing: the rule the server will pick', () => {
  const rule = (over: Partial<RetentionRule>): RetentionRule => ({ id: 'a', ruleSet: 'TT74_2025_BTC', categoryCode: 'PROJECT_INVESTMENT', classCode: 'Y20', retentionYears: 20, startBasis: 'FROM_CLOSED', handoverMonths: 12, legalBasis: 'Basis', legalConfirmationRef: null, confirmationStatus: 'CONFIRMED', precedence: 10, effectiveFrom: '2026-01-01', effectiveUntil: null, status: 'PUBLISHED', createdBy: null, approvedBy: null, legalConfirmedBy: null, version: 1, ...over });
  it('takes a confirmed rule before an unconfirmed one, then the lower precedence', () => {
    const pick = ruleForClosing([rule({ id: 'u', confirmationStatus: 'PENDING_CONFIRMATION', precedence: 1 }), rule({ id: 'c2', precedence: 20 }), rule({ id: 'c1', precedence: 10 })], 'PROJECT_INVESTMENT', '2026-11-08');
    expect(pick.rule?.id).toBe('c1');
    expect(pick.provisional).toBe(false);
  });
  it('is provisional when nothing is confirmed, and finds nothing for a category or a day out of force', () => {
    expect(ruleForClosing([rule({ confirmationStatus: 'PENDING_CONFIRMATION' })], 'PROJECT_INVESTMENT', '2026-11-08')).toMatchObject({ provisional: true });
    expect(ruleForClosing([rule({})], 'OTHER', '2026-11-08')).toEqual({ rule: undefined, provisional: true });
    expect(ruleForClosing([rule({ effectiveUntil: '2026-06-01' })], 'PROJECT_INVESTMENT', '2026-11-08').rule).toBeUndefined();
    expect(ruleForClosing([rule({ status: 'DRAFT' })], 'PROJECT_INVESTMENT', '2026-11-08').rule).toBeUndefined();
  });
});
