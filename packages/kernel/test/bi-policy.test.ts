import { DomainError } from '../src/errors.ts';
import { columnMasksProblem, hiddenColumns, predicateProblem, requireApplicablePolicies } from '../src/bi-policy.ts';

const DIMENSIONS = ['unit', 'fund_source', 'project'];
const thrown = (action: () => unknown): DomainError => {
  try {
    action();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('expected a DomainError');
};

describe('the row predicate of an access policy (ST-BI-003, BI BR-BI-05)', () => {
  it('AC-ST-BI-003-1: UAT-AC473 accepts the unit being in the scope of the person, fields among the dimensions of the dataset, and and, or, not over them', () => {
    expect(predicateProblem({ op: 'unit_in_scope' }, DIMENSIONS)).toBeUndefined();
    expect(predicateProblem({ op: 'and', args: [{ op: 'unit_in_scope' }, { op: 'in', field: 'fund_source', values: ['NSTW', 'NSDP'] }] }, DIMENSIONS)).toBeUndefined();
    expect(predicateProblem({ op: 'or', args: [{ op: 'eq', field: 'unit', value: 'U1' }, { op: 'not', args: [{ op: 'ne', field: 'project', value: 7 }] }] }, DIMENSIONS)).toBeUndefined();
  });

  it('AC-ST-BI-003-2: UAT-AC476 refuses a field that is not a dimension of the dataset (DIMENSION_NOT_IN_DATASET) and anything outside the grammar (PREDICATE_NOT_ALLOWED), with no literal true and no text of SQL', () => {
    expect(predicateProblem({ op: 'eq', field: 'contractor_tax_id', value: 'x' }, DIMENSIONS)).toEqual({ code: 'DIMENSION_NOT_IN_DATASET', field: 'contractor_tax_id' });
    for (const bad of [{ op: 'true' }, { op: 'raw_sql', sql: '1=1' }, { op: 'unit_in_scope', extra: 1 }, { op: 'eq', field: 'unit' }, { op: 'eq', field: 'unit; drop', value: 1 }, { op: 'eq', field: 'unit', value: { nested: 1 } }, { op: 'in', field: 'unit', values: [] }, { op: 'and', args: [{ op: 'unit_in_scope' }] }, { op: 'not', args: [] }, 'select 1', null, [] ]) {
      expect(predicateProblem(bad, DIMENSIONS)?.code).toBe('PREDICATE_NOT_ALLOWED');
    }
    expect(predicateProblem({ op: 'in', field: 'unit', values: Array.from({ length: 101 }, (_, i) => `U${i}`) }, DIMENSIONS)?.code).toBe('PREDICATE_NOT_ALLOWED');
  });

  it('bounds the depth and the size of a predicate', () => {
    let deep: unknown = { op: 'unit_in_scope' };
    for (let i = 0; i < 6; i += 1) deep = { op: 'not', args: [deep] };
    expect(predicateProblem(deep, DIMENSIONS)?.code).toBe('PREDICATE_NOT_ALLOWED');
    const wide = { op: 'and', args: Array.from({ length: 8 }, () => ({ op: 'or', args: Array.from({ length: 4 }, () => ({ op: 'unit_in_scope' })) })) };
    expect(predicateProblem(wide, DIMENSIONS)?.code).toBe('PREDICATE_NOT_ALLOWED');
  });
});

describe('the columns of a policy', () => {
  it('accepts a record of column to HIDE or MASK, and refuses another mode, a bad name, a list and too many columns', () => {
    expect(columnMasksProblem({ account_no: 'HIDE', beneficiary: 'MASK' })).toBeUndefined();
    expect(columnMasksProblem({})).toBeUndefined();
    expect(columnMasksProblem({ account_no: 'SHOW' })).toEqual({ code: 'VALIDATION_FAILED', field: 'column_masks.account_no' });
    expect(columnMasksProblem({ 'bad name': 'HIDE' })?.field).toBe('column_masks.bad name');
    expect(columnMasksProblem(['account_no'])?.field).toBe('column_masks');
    expect(columnMasksProblem(Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`c${i}`, 'HIDE'])))?.field).toBe('column_masks');
  });
});

describe('the policies that apply to a person', () => {
  const policy = (id: string, columnMasks: Record<string, string>) => ({ id, rowPredicate: { op: 'unit_in_scope' }, columnMasks });

  it('AC-ST-BI-003-1: UAT-AC473 is a refusal, never an empty answer, when no policy applies', () => {
    expect(thrown(() => requireApplicablePolicies([]))).toMatchObject({ code: 'ACCESS_POLICY_MISSING', status: 403 });
    expect(requireApplicablePolicies([policy('p', {})])).toHaveLength(1);
  });

  it('AC-ST-BI-003-1: UAT-AC473 hides the column account_no from every answer that any applicable policy hides it from, and masks the others', () => {
    expect(hiddenColumns([policy('a', { account_no: 'HIDE' }), policy('b', { account_no: 'MASK', beneficiary: 'MASK' })])).toEqual({ hidden: ['account_no'], masked: ['beneficiary'] });
    expect(hiddenColumns([policy('a', {})])).toEqual({ hidden: [], masked: [] });
  });
});
