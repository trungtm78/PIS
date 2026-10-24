import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import {
  BUSINESS_CLASSES,
  EMPTY_DRAFT,
  TECHNICAL_CLASSES,
  describeProblem,
  draftBody,
  endActionsFor,
  inRegisterOrder,
  recordKindOf,
  toHold,
  toPolicy,
  toReviewItem,
  validateDraft,
} from './model';
import type { DraftValues } from './model';

const POLICY = {
  id: 'p1',
  record_class: 'project_dossier',
  revision: 2,
  retention_years: 10,
  retention_basis: 'FROM_CLOSED',
  legal_basis_ref: 'TT 10/2022/TT-BNV',
  end_action: 'REVIEW_FOR_DESTRUCTION',
  effective_from: '2026-01-01',
  status: 'Published',
  created_by: 'u1',
  approved_by: 'u2',
  published_at: '2026-01-02T00:00:00.000Z',
  version: 3,
};

const valid = (overrides: Partial<DraftValues> = {}): DraftValues => ({
  recordClass: 'project_dossier',
  retentionBasis: 'FROM_CLOSED',
  retentionYears: '10',
  endAction: 'REVIEW_FOR_DESTRUCTION',
  legalBasisRef: 'TT 10/2022/TT-BNV',
  effectiveFrom: '2026-01-01',
  ...overrides,
});

describe('record classes', () => {
  it('knows the business and the technical classes of BR-ADM-11', () => {
    for (const name of BUSINESS_CLASSES) expect(recordKindOf(name)).toBe('BUSINESS');
    for (const name of TECHNICAL_CLASSES) expect(recordKindOf(name)).toBe('TECHNICAL');
    expect(recordKindOf('payment_request')).toBe('BUSINESS');
    expect(recordKindOf('widget')).toBeUndefined();
  });

  it('offers a business class the review and the transfer, a technical class the purge, and everything for a class it does not know', () => {
    expect(endActionsFor('project_dossier')).toEqual(['REVIEW_FOR_DESTRUCTION', 'ARCHIVE_TRANSFER']);
    expect(endActionsFor('outbox_event')).toEqual(['AUTO_PURGE_TECHNICAL']);
    expect(endActionsFor('widget')).toHaveLength(3);
  });
});

describe('toPolicy', () => {
  it('reads a version of the register', () => {
    expect(toPolicy(POLICY)).toEqual({
      id: 'p1',
      recordClass: 'project_dossier',
      revision: 2,
      retentionYears: 10,
      retentionBasis: 'FROM_CLOSED',
      legalBasisRef: 'TT 10/2022/TT-BNV',
      endAction: 'REVIEW_FOR_DESTRUCTION',
      effectiveFrom: '2026-01-01',
      status: 'Published',
      createdBy: 'u1',
      approvedBy: 'u2',
      publishedAt: '2026-01-02T00:00:00.000Z',
      version: 3,
    });
    expect(toPolicy({ ...POLICY, retention_years: null, retention_basis: 'PERMANENT', approved_by: null, published_at: null, status: 'Draft' })).toMatchObject({
      retentionYears: null,
      approvedBy: null,
      publishedAt: null,
      status: 'Draft',
    });
  });

  it.each([
    ['not an object', 'x'],
    ['an array', []],
    ['no id', { ...POLICY, id: undefined }],
    ['no class', { ...POLICY, record_class: '' }],
    ['an unknown basis', { ...POLICY, retention_basis: 'SOMETIME' }],
    ['an unknown end action', { ...POLICY, end_action: 'DELETE' }],
    ['an unknown status', { ...POLICY, status: 'Retired' }],
    ['no legal basis', { ...POLICY, legal_basis_ref: undefined }],
    ['no start', { ...POLICY, effective_from: undefined }],
    ['no author', { ...POLICY, created_by: undefined }],
    ['a revision that is not a number', { ...POLICY, revision: '2' }],
    ['a version that is not a number', { ...POLICY, version: '3' }],
  ])('drops a version with %s', (_name, raw) => {
    expect(toPolicy(raw)).toBeUndefined();
  });
});

describe('toReviewItem and toHold', () => {
  const ITEM = { id: 'r1', record_class: 'project_dossier', resource_type: 'project', resource_id: 'a1', basis_date: '2024-03-15', due_on: '2025-03-15', end_action: 'REVIEW_FOR_DESTRUCTION' };
  const HOLD = {
    id: 'h1',
    hold_kind: 'INSPECTION',
    status: 'Active',
    resource_scope: { kind: 'PROJECT', ids: ['a', 'b'] },
    authority_reference: '***',
    reason: 'An inspection of the project',
    effective_at: '2026-01-01T00:00:00.000Z',
  };

  it('reads a review item and a hold, and drops what cannot be read', () => {
    expect(toReviewItem(ITEM)).toEqual({ id: 'r1', recordClass: 'project_dossier', resourceType: 'project', resourceId: 'a1', basisDate: '2024-03-15', dueOn: '2025-03-15', endAction: 'REVIEW_FOR_DESTRUCTION' });
    for (const bad of ['x', [], { ...ITEM, id: undefined }, { ...ITEM, record_class: undefined }, { ...ITEM, resource_type: undefined }, { ...ITEM, resource_id: undefined }, { ...ITEM, basis_date: undefined }, { ...ITEM, due_on: undefined }, { ...ITEM, end_action: 'DELETE' }, { ...ITEM, end_action: undefined }]) {
      expect(toReviewItem(bad)).toBeUndefined();
    }
    expect(toHold(HOLD)).toEqual({
      id: 'h1',
      holdKind: 'INSPECTION',
      status: 'Active',
      scopeKind: 'PROJECT',
      scopeCount: 2,
      authorityReference: '***',
      reason: 'An inspection of the project',
      effectiveAt: '2026-01-01T00:00:00.000Z',
    });
    expect(toHold({ ...HOLD, resource_scope: { kind: 'TENANT' } })).toMatchObject({ scopeKind: 'TENANT', scopeCount: 0 });
    for (const bad of ['x', [], { ...HOLD, id: undefined }, { ...HOLD, hold_kind: 'OTHER' }, { ...HOLD, status: 'Gone' }, { ...HOLD, authority_reference: undefined }, { ...HOLD, reason: undefined }, { ...HOLD, effective_at: undefined }, { ...HOLD, resource_scope: 'x' }, { ...HOLD, resource_scope: { kind: 'GALAXY' } }, { ...HOLD, resource_scope: {} }]) {
      expect(toHold(bad)).toBeUndefined();
    }
  });
});

describe('validateDraft (BR-ADM-11)', () => {
  it('accepts a business class reviewed after ten years, a permanent one and a technical class purged after a year', () => {
    expect(validateDraft(valid())).toEqual({});
    expect(validateDraft(valid({ retentionBasis: 'PERMANENT', retentionYears: '', endAction: 'ARCHIVE_TRANSFER' }))).toEqual({});
    expect(validateDraft(valid({ recordClass: 'outbox_event', retentionBasis: 'FROM_CREATED', retentionYears: '1', endAction: 'AUTO_PURGE_TECHNICAL' }))).toEqual({});
  });

  it('refuses a job that purges a business class and PERMANENT with years (AC-ST-ADM-017-1)', () => {
    expect(validateDraft(valid({ endAction: 'AUTO_PURGE_TECHNICAL' }))).toEqual({ endAction: 'endAction' });
    expect(validateDraft(valid({ retentionBasis: 'PERMANENT', retentionYears: '10' }))).toEqual({ retentionYears: 'yearsNotAllowed' });
    expect(validateDraft(valid({ recordClass: 'outbox_event', retentionBasis: 'FROM_CREATED', endAction: 'REVIEW_FOR_DESTRUCTION' }))).toEqual({ endAction: 'endAction' });
    expect(validateDraft(valid({ recordClass: 'outbox_event', retentionBasis: 'FROM_CLOSED', endAction: 'AUTO_PURGE_TECHNICAL' }))).toEqual({ retentionBasis: 'basis' });
  });

  it('wants a known class, a number of years in range, a legal basis and a real day', () => {
    expect(validateDraft(EMPTY_DRAFT)).toEqual({ recordClass: 'required', retentionYears: 'yearsRequired', legalBasisRef: 'legalBasis', effectiveFrom: 'date' });
    expect(validateDraft(valid({ recordClass: 'Bad Class' }))).toEqual({ recordClass: 'classFormat' });
    expect(validateDraft(valid({ recordClass: 'widget' }))).toEqual({ recordClass: 'classUnknown' });
    for (const years of ['0', '101', '2.5', 'ten', '-3', '1000']) expect(validateDraft(valid({ retentionYears: years }))).toEqual({ retentionYears: 'yearsRange' });
    expect(validateDraft(valid({ legalBasisRef: 'x' }))).toEqual({ legalBasisRef: 'legalBasis' });
    expect(validateDraft(valid({ legalBasisRef: 'x'.repeat(501) }))).toEqual({ legalBasisRef: 'legalBasis' });
    for (const day of ['', '2026-02-30', '1/1/2026', '2026-13-01']) expect(validateDraft(valid({ effectiveFrom: day }))).toEqual({ effectiveFrom: 'date' });
  });

  it('builds the body of createRetentionPolicyVersion, trimmed, without years for a permanent policy', () => {
    expect(draftBody(valid({ recordClass: ' project_dossier ', legalBasisRef: ' TT 10/2022 ', retentionYears: ' 10 ' }))).toEqual({
      record_class: 'project_dossier',
      retention_years: 10,
      retention_basis: 'FROM_CLOSED',
      legal_basis_ref: 'TT 10/2022',
      end_action: 'REVIEW_FOR_DESTRUCTION',
      effective_from: '2026-01-01',
    });
    expect(draftBody(valid({ retentionBasis: 'PERMANENT', retentionYears: '' }))).not.toHaveProperty('retention_years');
  });
});

describe('describeProblem and inRegisterOrder', () => {
  const failure = (code: string, status = 422, extensions: Record<string, unknown> = {}) => new ApiError({ status, code, correlationId: 'c', extensions });

  it('maps the codes of the commands to the reasons the screen words', () => {
    expect(describeProblem(failure('RETENTION_POLICY_INVALID')).reason).toBe('invalid');
    expect(describeProblem(failure('VALIDATION_FAILED')).reason).toBe('invalid');
    expect(describeProblem(failure('INVALID_REQUEST', 400)).reason).toBe('invalid');
    expect(describeProblem(failure('VERSION_CONFLICT', 409)).reason).toBe('conflict');
    expect(describeProblem(failure('SELF_APPROVAL_DENIED', 403)).reason).toBe('selfApproval');
    expect(describeProblem(failure('RESOURCE_NOT_FOUND', 404)).reason).toBe('notFound');
    expect(describeProblem(failure('SCOPE_DENIED', 403)).reason).toBe('denied');
    expect(describeProblem(failure('ENTITLEMENT_DENIED', 403)).reason).toBe('denied');
    expect(describeProblem(failure('SESSION_EXPIRED', 401)).reason).toBe('session');
    expect(describeProblem(failure('OTHER', 500)).reason).toBe('general');
    expect(describeProblem(new Error('x'))).toEqual({ reason: 'general', findings: [] });
  });

  it('keeps the findings of RETENTION_POLICY_INVALID that the screen knows and drops the others', () => {
    const problem = describeProblem(
      failure('RETENTION_POLICY_INVALID', 422, {
        errors: [{ field: 'end_action', code: 'END_ACTION_NOT_ALLOWED' }, { field: 'x', code: 'FROM_THE_FUTURE' }, 'junk', { field: 3, code: 'YEARS_RANGE' }, { field: 'retention_years', code: 'YEARS_NOT_ALLOWED' }],
      }),
    );
    expect(problem.findings).toEqual([
      { field: 'end_action', code: 'END_ACTION_NOT_ALLOWED' },
      { field: 'retention_years', code: 'YEARS_NOT_ALLOWED' },
    ]);
    expect(describeProblem(failure('RETENTION_POLICY_INVALID', 422, { errors: 'x' })).findings).toEqual([]);
  });

  it('orders the register by class and the versions of a class newest first', () => {
    const make = (recordClass: string, revision: number) => toPolicy({ ...POLICY, id: `${recordClass}-${revision}`, record_class: recordClass, revision });
    const ordered = inRegisterOrder([make('project_dossier', 1), make('audit_event', 1), make('project_dossier', 2)].flatMap((policy) => (policy === undefined ? [] : [policy])));
    expect(ordered.map((policy) => policy.id)).toEqual(['audit_event-1', 'project_dossier-2', 'project_dossier-1']);
  });
});
