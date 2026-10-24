import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DomainError } from './errors.ts';
import { draftFindings, headerFindings, notAfterCurrentFinding, parseVnd, refuseDoa, resolveDoa, submitFindings, unknownReferenceFinding, validateDoaDraft, validateDoaForSubmit } from './doa.ts';
import type { DoaMatrixRecord, DoaQuery, DoaResolution, DoaRuleContent } from './doa.ts';

type DraftRow = [documentType: string, unitId: string, min: string, max: string | null];
interface Vectors {
  unitPaths: Record<string, string>;
  matrices: Record<string, DoaMatrixRecord>;
  resolutions: Array<{ name: string; matrices: string[]; query: DoaQuery; expected: DoaResolution }>;
  refused: Array<{ name: string; matrices: string[]; query: DoaQuery; pathsWithout?: string; code: string; detail: string }>;
  drafts: Array<{ name: string; rules: DraftRow[]; draft: string[]; submit: string[] }>;
}
const vectors = JSON.parse(readFileSync(resolve(process.cwd(), '../contracts/test-vectors/doa-matrix.json'), 'utf8')) as Vectors;

const matricesOf = (names: string[]): DoaMatrixRecord[] => names.map((name) => vectors.matrices[name] as DoaMatrixRecord);
const pathsOf = (without?: string): Map<string, string> => new Map(Object.entries(vectors.unitPaths).filter(([unit]) => unit !== without));
const ruleOf = ([document_type, unit_id, amount_min_vnd, amount_max_vnd]: DraftRow): DoaRuleContent => ({ document_type, unit_id, amount_min_vnd, amount_max_vnd, approver_role_id: 'ROLE' });
const codesOf = (found: Array<{ field: string; code: string }>): string[] => found.map((entry) => `${entry.field}:${entry.code}`);
const problem = (work: () => unknown): DomainError | undefined => {
  try {
    work();
  } catch (error) {
    return error as DomainError;
  }
  return undefined;
};

describe('resolveDoa (BR-ADM-03, UAT-AC126)', () => {
  it.each(vectors.resolutions)('$name', ({ matrices, query, expected }) => {
    expect(resolveDoa(matricesOf(matrices), pathsOf(), query)).toEqual(expected);
  });

  it.each(vectors.refused)('refuses $name', ({ matrices, query, pathsWithout, code, detail }) => {
    expect(problem(() => resolveDoa(matricesOf(matrices), pathsOf(pathsWithout), query))).toMatchObject({ code, status: 422, detail });
  });

  it('ignores a rule whose unit has no path', () => {
    const paths = pathsOf('province');
    const answer = problem(() => resolveDoa(matricesOf(['current']), paths, { documentType: 'FX', amountVnd: '1', unitId: 'department', businessDate: '2026-03-01' }));
    expect(answer).toMatchObject({ code: 'DOA_RULE_NOT_FOUND' });
  });

  it('skips a band whose amounts cannot be read instead of matching it', () => {
    const broken: DoaMatrixRecord = {
      id: 'm',
      status: 'Published',
      effectiveFrom: '2026-01-01',
      effectiveUntil: null,
      rules: [
        { id: 'a', document_type: 'FX', unit_id: 'province', amount_min_vnd: 'x', approver_role_id: 'R1' },
        { id: 'b', document_type: 'FX', unit_id: 'province', amount_min_vnd: '0', amount_max_vnd: 'y', approver_role_id: 'R2' },
        { id: 'c', document_type: 'FX', unit_id: 'province', amount_min_vnd: '0', amount_max_vnd: undefined, approver_role_id: 'R3' },
      ],
    };
    expect(resolveDoa([broken], pathsOf(), { documentType: 'FX', amountVnd: '5', unitId: 'province', businessDate: '2026-03-01' }).ruleId).toBe('c');
  });

  it('takes the matrix that began last when two cover the same day', () => {
    const older = { ...(vectors.matrices.current as DoaMatrixRecord), id: 'older', effectiveFrom: '2025-06-01' };
    const answer = resolveDoa([older, vectors.matrices.current as DoaMatrixRecord], pathsOf(), { documentType: 'FX', amountVnd: '1', unitId: 'province', businessDate: '2026-03-01' });
    expect(answer.matrixVersionId).toBe('matrix-2');
  });
});

describe('the findings of a matrix (BR-ADM-04, UAT-AC127)', () => {
  it.each(vectors.drafts)('$name', ({ rules, draft, submit }) => {
    const content = rules.map(ruleOf);
    expect(codesOf(draftFindings(content))).toEqual(draft);
    expect(codesOf(submitFindings(content))).toEqual(submit);
  });

  it('refuses with 422 DOA_MATRIX_INVALID, naming the first field and listing every finding with an i18n key', () => {
    const gap = vectors.drafts[2] as Vectors['drafts'][number];
    const failure = problem(() => validateDoaForSubmit(gap.rules.map(ruleOf)));
    expect(failure).toMatchObject({ code: 'DOA_MATRIX_INVALID', status: 422, detail: 'rules[1].amount_min_vnd' });
    expect(failure?.extensions).toEqual({ errors: [{ field: 'rules[1].amount_min_vnd', code: 'GAP', message: 'adm.doa.error.gap' }] });
    expect(problem(() => validateDoaForSubmit(vectors.drafts[0]?.rules.map(ruleOf) ?? []))).toBeUndefined();
  });

  it('lets a gap through when a draft is stored and refuses an overlap there', () => {
    expect(problem(() => validateDoaDraft((vectors.drafts[2] as Vectors['drafts'][number]).rules.map(ruleOf)))).toBeUndefined();
    expect(problem(() => validateDoaDraft((vectors.drafts[3] as Vectors['drafts'][number]).rules.map(ruleOf)))).toMatchObject({ code: 'DOA_MATRIX_INVALID', detail: 'rules[1].amount_min_vnd' });
  });

  it('names the codes in the i18n keys: NOT_FROM_ZERO is notFromZero', () => {
    const found = submitFindings([ruleOf(['FX', 'province', '1', null])]);
    expect(found).toEqual([{ field: 'rules[0].amount_min_vnd', code: 'NOT_FROM_ZERO', message: 'adm.doa.error.notFromZero' }]);
  });

  it('refuses a submission without a rule, though a draft without one is nothing to refuse (the request schema asks for at least one)', () => {
    expect(codesOf(submitFindings([]))).toEqual(['rules:NO_RULES']);
    expect(draftFindings([])).toEqual([]);
  });
});

describe('parseVnd', () => {
  it.each([
    ['0', 0n],
    ['5000000000', 5_000_000_000n],
    ['999999999999999999999999', 999_999_999_999_999_999_999_999n],
  ])('reads %s as whole VND', (text, expected) => {
    expect(parseVnd(text)).toBe(expected);
  });

  it.each(['', '-1', '1.5', '01', '1e9', ' 1', '1000000000000000000000000', 'abc'])('does not read %j', (text) => {
    expect(parseVnd(text)).toBeUndefined();
  });
});

describe('the findings about a version as a whole', () => {
  it('accepts real dates and a version that ends after it starts, or has no end', () => {
    expect(headerFindings('2026-01-01', undefined)).toEqual([]);
    expect(headerFindings('2026-01-01', null)).toEqual([]);
    expect(headerFindings('2026-01-01', '2026-01-02')).toEqual([]);
  });

  it('refuses a date that is not a date, and an end that is not after the start', () => {
    expect(codesOf(headerFindings('2026-02-30', null))).toEqual(['effective_from:DATE_INVALID']);
    expect(codesOf(headerFindings('2026-01-01', 'soon'))).toEqual(['effective_until:DATE_INVALID']);
    expect(codesOf(headerFindings('2026-01-01', '2026-01-01'))).toEqual(['effective_until:RANGE_INVALID']);
    expect(codesOf(headerFindings('2026-01-01', '2025-12-31'))).toEqual(['effective_until:RANGE_INVALID']);
    expect(codesOf(headerFindings('nope', '2026-01-01'))).toEqual(['effective_from:DATE_INVALID']);
  });

  it('names a version that would not start after the one in force, and a rule that names a unit or a role the tenant lacks', () => {
    expect(notAfterCurrentFinding()).toEqual({ field: 'effective_from', code: 'NOT_AFTER_CURRENT', message: 'adm.doa.error.notAfterCurrent' });
    expect(unknownReferenceFinding(2, 'unit_id')).toEqual({ field: 'rules[2].unit_id', code: 'UNIT_UNKNOWN', message: 'adm.doa.error.unitUnknown' });
    expect(unknownReferenceFinding(0, 'approver_role_id')).toEqual({ field: 'rules[0].approver_role_id', code: 'ROLE_UNKNOWN', message: 'adm.doa.error.roleUnknown' });
  });

  it('refuses nothing for no findings and 422 DOA_MATRIX_INVALID for any', () => {
    expect(problem(() => refuseDoa([]))).toBeUndefined();
    expect(problem(() => refuseDoa([notAfterCurrentFinding()]))).toMatchObject({ code: 'DOA_MATRIX_INVALID', status: 422, detail: 'effective_from' });
  });
});
