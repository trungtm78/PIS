import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { bandProblems, describeProblem, emptyValues, hasErrors, inputsOf, matrixBody, newRule, toMatrix, validateForm, valuesOfMatrix } from './model';
import type { DoaValues } from './model';

const filled = (changes: Partial<DoaValues> = {}): DoaValues => ({
  effectiveFrom: '2026-01-01',
  effectiveUntil: '',
  legalBasis: 'Internal regulation 12/QD-2026',
  rules: [newRule({ documentType: 'FX', unitId: 'u1', roleId: 'r1', min: '0', max: '' })],
  ...changes,
});

const RAW = {
  id: 'm1',
  revision: 3,
  status: 'PendingApproval',
  effective_from: '2026-01-01',
  effective_until: '2027-01-01',
  legal_basis_ref: 'Internal regulation 12/QD-2026',
  created_by: 'u1',
  last_edited_by: 'u2',
  approved_by: null,
  published_at: null,
  version: 2,
  rules: [
    { id: 'a', document_type: 'FX', unit_id: 'u1', include_subtree: false, amount_min_vnd: '0', amount_max_vnd: '5000000000', approver_role_id: 'r1', approval_levels: 2, requires_distinct_approvers: false },
    { id: 'b', document_type: 'FX', unit_id: 'u1', amount_min_vnd: '5000000000', approver_role_id: 'r2' },
    { document_type: 'no id' },
    'junk',
  ],
};

describe('reading a version', () => {
  it('reads every field and the defaults of the optional ones, and skips what is not a rule', () => {
    expect(toMatrix(RAW)).toEqual({
      id: 'm1',
      revision: 3,
      status: 'PendingApproval',
      effectiveFrom: '2026-01-01',
      effectiveUntil: '2027-01-01',
      legalBasis: 'Internal regulation 12/QD-2026',
      createdBy: 'u1',
      lastEditedBy: 'u2',
      approvedBy: null,
      publishedAt: null,
      version: 2,
      rules: [
        { id: 'a', document_type: 'FX', unit_id: 'u1', include_subtree: false, amount_min_vnd: '0', amount_max_vnd: '5000000000', approver_role_id: 'r1', approval_levels: 2, requires_distinct_approvers: false },
        { id: 'b', document_type: 'FX', unit_id: 'u1', include_subtree: true, amount_min_vnd: '5000000000', amount_max_vnd: null, approver_role_id: 'r2', approval_levels: 1, requires_distinct_approvers: true },
      ],
    });
  });

  it('is not a version without an id, and treats an odd row as an empty draft', () => {
    expect(toMatrix(null)).toBeUndefined();
    expect(toMatrix({ revision: 1 })).toBeUndefined();
    expect(toMatrix({ id: 'm2', status: 'Weird', rules: 'none' })).toMatchObject({ status: 'Draft', rules: [], revision: 0, effectiveUntil: null, lastEditedBy: null });
  });

  it('fills the form from a version, row by row, to edit the draft or to write the next revision', () => {
    const view = toMatrix(RAW);
    if (view === undefined) throw new Error('no view');
    const values = valuesOfMatrix(view);
    expect(values).toMatchObject({ effectiveFrom: '2026-01-01', effectiveUntil: '2027-01-01', legalBasis: 'Internal regulation 12/QD-2026' });
    expect(values.rules.map((rule) => ({ documentType: rule.documentType, unitId: rule.unitId, includeSubtree: rule.includeSubtree, min: rule.min, max: rule.max, roleId: rule.roleId, levels: rule.levels, distinct: rule.distinct }))).toEqual([
      { documentType: 'FX', unitId: 'u1', includeSubtree: false, min: '0', max: '5000000000', roleId: 'r1', levels: 2, distinct: false },
      { documentType: 'FX', unitId: 'u1', includeSubtree: true, min: '5000000000', max: '', roleId: 'r2', levels: 1, distinct: true },
    ]);
    expect(new Set(values.rules.map((rule) => rule.key)).size).toBe(2);
  });
});

describe('the request body', () => {
  it('trims the text, leaves the end out of a band that has none and out of a version that has none', () => {
    const body = matrixBody(filled({ legalBasis: '  Regulation text  ', rules: [newRule({ documentType: ' FX ', unitId: 'u1', roleId: 'r1', min: ' 0 ', max: ' 9 ', levels: 3, distinct: false, includeSubtree: false }), newRule({ documentType: 'FX', unitId: 'u1', roleId: 'r2', min: '9' })] }));
    expect(body).toEqual({
      effective_from: '2026-01-01',
      legal_basis_ref: 'Regulation text',
      rules: [
        { document_type: 'FX', unit_id: 'u1', include_subtree: false, amount_min_vnd: '0', amount_max_vnd: '9', approver_role_id: 'r1', approval_levels: 3, requires_distinct_approvers: false },
        { document_type: 'FX', unit_id: 'u1', include_subtree: true, amount_min_vnd: '9', approver_role_id: 'r2', approval_levels: 1, requires_distinct_approvers: true },
      ],
    });
    expect(matrixBody(filled({ effectiveUntil: '2027-01-01' }))).toMatchObject({ effective_until: '2027-01-01' });
  });

  it('gives the rules of the form in the shape the findings take, with a blank end as no end', () => {
    expect(inputsOf(filled())[0]).toMatchObject({ document_type: 'FX', amount_min_vnd: '0', amount_max_vnd: null });
  });
});

describe('the form', () => {
  it('starts with one empty first band that begins at 0', () => {
    const values = emptyValues();
    expect(values.rules).toHaveLength(1);
    expect(values.rules[0]).toMatchObject({ min: '0', max: '', includeSubtree: true, levels: 1, distinct: true });
  });

  it('accepts a complete form', () => {
    expect(hasErrors(validateForm(filled()))).toBe(false);
  });

  it.each([
    ['no start date', { effectiveFrom: '' }, { effectiveFrom: 'required' }],
    ['an end that is not after the start', { effectiveUntil: '2026-01-01' }, { effectiveUntil: 'order' }],
    ['no legal basis', { legalBasis: '  ' }, { legalBasis: 'required' }],
    ['a legal basis that is too short', { legalBasis: 'abc' }, { legalBasis: 'tooShort' }],
    ['no rule', { rules: [] }, { rules: 'required' }],
    ['more than 500 rules', { rules: Array.from({ length: 501 }, () => newRule({ documentType: 'FX', unitId: 'u1', roleId: 'r1' })) }, { rules: 'tooMany' }],
  ] as Array<[string, Partial<DoaValues>, Record<string, string>]>)('refuses %s', (_label, changes, expected) => {
    expect(validateForm(filled(changes)).header).toEqual(expected);
  });

  it('refuses a row without a kind of document, with one that is too long, and without a unit or a role, by its position', () => {
    const rows = validateForm(filled({ rules: [newRule({ documentType: '', unitId: '', roleId: '' }), newRule({ documentType: 'X'.repeat(61), unitId: 'u1', roleId: 'r1' }), newRule({ documentType: 'FX', unitId: 'u1', roleId: 'r1' })] })).rows;
    expect(rows).toEqual([{ documentType: 'required', unitId: 'unit', roleId: 'role' }, { documentType: 'tooLong' }, {}]);
  });

  it('tells the bands that cannot be saved from the ones that cannot be submitted', () => {
    const gap = filled({ rules: [newRule({ documentType: 'FX', unitId: 'u1', roleId: 'r1', min: '0', max: '5' }), newRule({ documentType: 'FX', unitId: 'u1', roleId: 'r1', min: '9' })] });
    expect(bandProblems(gap)).toEqual({ draft: [], submit: [{ field: 'rules[1].amount_min_vnd', code: 'GAP' }] });
  });
});

describe('describing a refusal', () => {
  const problem = (code: string, extensions: Record<string, unknown> = {}) => new ApiError({ status: 422, code, correlationId: 'c', extensions });

  it('lists the findings of DOA_MATRIX_INVALID in the order of the server, and skips what is not a finding', () => {
    expect(describeProblem(problem('DOA_MATRIX_INVALID', { errors: [{ field: 'rules[1].amount_min_vnd', code: 'GAP' }, { field: 7 }, 'junk', { field: 'effective_from', code: 'NOT_AFTER_CURRENT' }] }))).toEqual({
      reason: 'matrixInvalid',
      findings: [
        { field: 'rules[1].amount_min_vnd', code: 'GAP' },
        { field: 'effective_from', code: 'NOT_AFTER_CURRENT' },
      ],
    });
  });

  it.each([
    ['SELF_APPROVAL_DENIED', 'selfApproval'],
    ['VERSION_CONFLICT', 'conflict'],
    ['DOA_MATRIX_NOT_DRAFT', 'notDraft'],
    ['DOA_STATE_INVALID', 'stateInvalid'],
    ['VALIDATION_FAILED', 'invalid'],
    ['INVALID_REQUEST', 'invalid'],
    ['FIELD_NOT_ALLOWED', 'invalid'],
    ['RESOURCE_NOT_FOUND', 'notFound'],
    ['SCOPE_DENIED', 'denied'],
    ['ENTITLEMENT_DENIED', 'denied'],
    ['SESSION_EXPIRED', 'session'],
    ['SOMETHING_ELSE', 'general'],
  ])('maps %s to %s', (code, reason) => {
    expect(describeProblem(problem(code))).toEqual({ reason, findings: [] });
  });

  it('says only "general" for a failure that is not an API error, and has no findings when `errors` is not a list', () => {
    expect(describeProblem(new Error('boom'))).toEqual({ reason: 'general', findings: [] });
    expect(describeProblem(problem('DOA_MATRIX_INVALID', { errors: 'many' })).findings).toEqual([]);
  });
});
