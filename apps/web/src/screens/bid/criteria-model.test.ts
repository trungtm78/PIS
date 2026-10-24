import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import {
  criteriaBody,
  criteriaLink,
  defaultVersion,
  describeProblem,
  draftOf,
  emptyForm,
  emptyRow,
  hasErrors,
  hasScored,
  rowsOf,
  toCriteriaVersion,
  toEligiblePackage,
  validateCriteria,
  weightsTotal,
} from './criteria-model';
import type { CriteriaForm, CriteriaVersion, CriterionRow } from './criteria-model';
import { pack, passFail, scored, version } from './criteria-test-support';

const PACKAGE = '00000000-0000-4000-8000-002000000001';

const row = (change: Partial<CriterionRow> = {}): CriterionRow => ({ ...emptyRow(), code: 'C1', name: 'Kinh nghiệm', kind: 'SCORED', weight: '100', maxScore: '10', threshold: '', mandatory: false, evidence: '', ...change });
const formOf = (rows: CriterionRow[], change: Partial<CriteriaForm> = {}): CriteriaForm => ({ packageId: PACKAGE, legalBasis: 'Luật Đấu thầu 22/2023/QH15', rows, ...change });
const problem = (code: string, extensions: Record<string, unknown> = {}, detail?: string) => new ApiError({ status: 422, code, correlationId: 'c', extensions, ...(detail === undefined ? {} : { detail }) });

describe('reading a version of the criteria', () => {
  it('reads the package, the project, the criteria and the sum of the weights', () => {
    const read = toCriteriaVersion(version(2, { status: 'DRAFT', approved_at: null, version: 1 }));
    expect(read).toMatchObject({
      id: version(2).id,
      packageCode: 'GT-1',
      packageTitle: 'Gói thầu xây lắp 1',
      packageStatus: 'PLANNED',
      projectCode: 'PRJ-001',
      revision: 2,
      status: 'DRAFT',
      weightsSum: 100,
      legalBasis: 'Luật Đấu thầu 22/2023/QH15',
      approvedAt: null,
      version: 1,
    });
    expect(read?.criteria.map((criterion) => [criterion.code, criterion.kind, criterion.weight, criterion.maxScore, criterion.threshold, criterion.mandatory])).toEqual([
      ['C1', 'SCORED', 40, 10, 5, false],
      ['C2', 'SCORED', 30, 10, 5, false],
      ['C3', 'SCORED', 20, 10, 5, false],
      ['C4', 'SCORED', 10, 10, 5, false],
      ['R1', 'PASS_FAIL', null, null, null, true],
    ]);
    expect(read?.criteria[0]?.requiredEvidence).toEqual(['Báo cáo tài chính đã kiểm toán']);
  });

  it('keeps a set without weights, skips what is not a criterion and refuses what is not a version', () => {
    expect(toCriteriaVersion(version(1, { weights_sum: null, criteria: [passFail('R1'), { code: 'X' }, 'x', { code: 'Y', name: 'Y', kind: 'RANKED' }] }))).toMatchObject({ weightsSum: null, criteria: [{ code: 'R1' }] });
    for (const bad of [undefined, null, 'x', {}, version(1, { status: 'OPEN' }), version(1, { revision: '1' }), version(1, { version: 1.5 }), version(1, { id: 5 }), version(1, { package: null }), version(1, { package: { id: 'x' } })]) {
      expect(toCriteriaVersion(bad)).toBeUndefined();
    }
    expect(toCriteriaVersion(version(1, { criteria: 'x', legal_basis: 5, package: { id: PACKAGE, code: 'GT', project: null } }))).toMatchObject({ criteria: [], legalBasis: null, packageTitle: null, projectCode: '', packageStatus: '' });
  });

  it('offers criteria only for the packages of an approved plan', () => {
    expect(toEligiblePackage(pack(1, 1, { status: 'PLANNED' }))?.code).toBe('GT-1');
    expect(toEligiblePackage(pack(1, null, { status: 'AWARDED' }))?.code).toBe('GT-1');
    for (const status of ['DRAFT', 'IN_REVIEW', 'CANCELLED']) expect(toEligiblePackage(pack(1, 1, { status }))).toBeUndefined();
    expect(toEligiblePackage('x')).toBeUndefined();
  });

  it('shows the version in force first, else the newest, and finds the draft in work', () => {
    const read = (n: number, status: string): CriteriaVersion => toCriteriaVersion(version(n, { status })) as CriteriaVersion;
    const list = [read(3, 'DRAFT'), read(2, 'APPROVED'), read(1, 'SUPERSEDED')];
    expect(defaultVersion(list)?.revision).toBe(2);
    expect(defaultVersion([read(2, 'DRAFT'), read(1, 'SUPERSEDED')])?.revision).toBe(2);
    expect(defaultVersion([])).toBeUndefined();
    expect(draftOf(list)?.revision).toBe(3);
    expect(draftOf([read(2, 'APPROVED')])).toBeUndefined();
    expect(criteriaLink(PACKAGE)).toBe(`/bid/bid-04?package=${PACKAGE}`);
  });
});

describe('the form', () => {
  it('starts with one scored row for the package and takes the rows of a version as the start of the next', () => {
    const empty = emptyForm(PACKAGE);
    expect(empty).toMatchObject({ packageId: PACKAGE, legalBasis: '' });
    expect(empty.rows).toHaveLength(1);
    expect(empty.rows[0]).toMatchObject({ kind: 'SCORED', maxScore: '10', mandatory: false });
    expect(emptyForm().packageId).toBe('');
    const rows = rowsOf(toCriteriaVersion(version(1, { criteria: [scored('C1', 60, { required_evidence: ['A bảo lãnh', 'B hợp đồng'] }), passFail('R1')] })) as CriteriaVersion);
    expect(rows.map((item) => [item.code, item.kind, item.weight, item.maxScore, item.threshold, item.mandatory, item.evidence])).toEqual([
      ['C1', 'SCORED', '60', '10', '5', false, 'A bảo lãnh\nB hợp đồng'],
      ['R1', 'PASS_FAIL', '', '', '', true, ''],
    ]);
    expect(new Set(rows.map((item) => item.key)).size).toBe(2);
  });

  it('adds up the weights of the scored rows that hold a whole weight, while typing', () => {
    expect(weightsTotal([row({ weight: '40' }), row({ weight: ' 30 ' }), row({ weight: 'x' }), row({ weight: '' }), row({ kind: 'PASS_FAIL', weight: '99' })])).toBe(70);
    expect(weightsTotal([])).toBe(0);
    expect(hasScored([row({ kind: 'PASS_FAIL' })])).toBe(false);
    expect(hasScored([row({ kind: 'PASS_FAIL' }), row()])).toBe(true);
  });
});

describe('validating the criteria before they are sent', () => {
  it('accepts a set whose weights add up to 100, with pass/fail criteria beside them', () => {
    const rows = [row({ code: 'C1', weight: '60', threshold: '5' }), row({ code: 'C2', weight: '40' }), row({ code: 'R1', kind: 'PASS_FAIL', weight: 'ignored', maxScore: '' })];
    expect(hasErrors(validateCriteria(formOf(rows)))).toBe(false);
  });

  it('accepts a set without a scored criterion: there is no sum to add up', () => {
    expect(hasErrors(validateCriteria(formOf([row({ kind: 'PASS_FAIL', code: 'R1', name: 'Giấy phép' })])))).toBe(false);
  });

  it('says what is missing in the package, the legal basis and the list', () => {
    const errors = validateCriteria({ packageId: '', legalBasis: '  ', rows: [] });
    expect(errors).toMatchObject({ packageId: 'required', legalBasis: 'required', rows: 'required' });
    expect(validateCriteria(formOf([row()], { packageId: 'nope' })).packageId).toBe('invalidId');
    expect(validateCriteria(formOf([row()], { legalBasis: 'xx' })).legalBasis).toBe('tooShort');
    expect(validateCriteria(formOf([row()], { legalBasis: 'x'.repeat(2001) })).legalBasis).toBe('tooLong');
    const many = Array.from({ length: 51 }, (_, index) => row({ code: `C${index}`, kind: 'PASS_FAIL' }));
    expect(validateCriteria(formOf(many)).rows).toBe('tooMany');
  });

  it('judges the code, the name, the weight, the scale, the threshold and the evidence of each criterion', () => {
    const rows = [
      row({ code: '', name: '', weight: '', maxScore: '' }),
      row({ code: 'bad code', name: 'x', weight: '0', maxScore: '101', threshold: '3' }),
      row({ code: 'Dup', name: 'y'.repeat(301), weight: '1.5', maxScore: 'x' }),
      row({ code: 'dup', weight: '50', maxScore: '10', threshold: '11', evidence: 'a\nok evidence' }),
      row({ code: 'C5', weight: '50', maxScore: '10', threshold: 'x', evidence: Array.from({ length: 11 }, () => 'bằng chứng').join('\n') }),
      row({ code: 'C6', weight: '10', maxScore: '10', threshold: '-1' }),
    ];
    const errors = validateCriteria(formOf(rows));
    const at = (index: number) => errors.items[(rows[index] as CriterionRow).key];
    expect(at(0)).toEqual({ code: 'required', name: 'required', weight: 'required', maxScore: 'required' });
    expect(at(1)).toEqual({ code: 'invalidCode', name: 'tooShort', weight: 'outOfRange', maxScore: 'outOfRange' });
    expect(at(2)).toEqual({ name: 'tooLong', weight: 'invalidWhole', maxScore: 'invalidWhole' });
    expect(at(3)).toEqual({ code: 'duplicateCode', threshold: 'outOfRange', evidence: 'tooShort' });
    expect(at(4)).toEqual({ threshold: 'invalidWhole', evidence: 'tooMany' });
    expect(at(5)).toEqual({ threshold: 'invalidWhole' });
    // The total is not judged while a weight is wrong: the typo is told in its place.
    expect(errors.rows).toBeUndefined();
  });

  it('tells the total when every weight reads and they do not add up to 100', () => {
    const errors = validateCriteria(formOf([row({ code: 'C1', weight: '30' }), row({ code: 'C2', weight: '30' }), row({ code: 'C3', weight: '20' }), row({ code: 'C4', weight: '10' })]));
    expect(errors.rows).toBe('weightTotal');
    expect(Object.keys(errors.items)).toEqual([]);
    expect(validateCriteria(formOf([row({ weight: '101' })])).items).not.toEqual({});
  });

  it('judges a threshold against the scale of its own row', () => {
    const errors = validateCriteria(formOf([row({ weight: '100', maxScore: '5', threshold: '5' })]));
    expect(hasErrors(errors)).toBe(false);
    // A scale that cannot be read leaves the threshold to the highest scale there is.
    expect(Object.values(validateCriteria(formOf([row({ weight: '100', maxScore: '', threshold: '4' })])).items)[0]).toEqual({ maxScore: 'required' });
    expect(Object.values(validateCriteria(formOf([row({ weight: '100', maxScore: '', threshold: '101' })])).items)[0]).toEqual({ maxScore: 'required', threshold: 'outOfRange' });
    expect(Object.values(validateCriteria(formOf([row({ weight: '100', maxScore: '5', threshold: '6' })])).items)[0]).toEqual({ threshold: 'outOfRange' });
  });
});

describe('the body of the command', () => {
  it('sends the allowlist of the contract, trimmed, with a weight and a scale on the scored criteria only', () => {
    const body = criteriaBody(
      formOf(
        [
          row({ code: ' C1 ', name: ' Kinh nghiệm ', weight: ' 100 ', maxScore: '10', threshold: ' 5 ', mandatory: true, evidence: ' A \n\n B ' }),
          row({ code: 'R1', name: 'Giấy phép', kind: 'PASS_FAIL', weight: '7', maxScore: '3', threshold: '1', mandatory: false }),
        ],
        { packageId: ` ${PACKAGE.toUpperCase()} `, legalBasis: ' Luật Đấu thầu ' },
      ),
    );
    expect(body).toEqual({
      package_id: PACKAGE,
      legal_basis: 'Luật Đấu thầu',
      criteria_json: {
        criteria: [
          { code: 'C1', name: 'Kinh nghiệm', kind: 'SCORED', weight: 100, max_score: 10, threshold: 5, mandatory: true, required_evidence: ['A', 'B'] },
          { code: 'R1', name: 'Giấy phép', kind: 'PASS_FAIL', mandatory: false, required_evidence: [] },
        ],
      },
    });
    expect(criteriaBody(formOf([row({ threshold: '' })])).criteria_json.criteria[0]).toMatchObject({ threshold: null });
  });
});

describe('what the server refused', () => {
  it('names the reason, the sum the server counted and the criterion that fell under a rule with its legal basis', () => {
    expect(describeProblem(problem('CRITERIA_WEIGHT_INVALID', { weights_sum: 90 }))).toMatchObject({ reason: 'weight', weightsSum: 90 });
    expect(describeProblem(problem('PROHIBITED_CRITERION', { criterion_code: 'C2', legal_basis: 'Luật Đấu thầu' }))).toMatchObject({ reason: 'prohibited', criterionCode: 'C2', legalBasis: 'Luật Đấu thầu' });
    expect(describeProblem(problem('VALIDATION_FAILED', {}, 'criteria_json.criteria.0.weight'))).toMatchObject({ reason: 'validation', field: 'criteria_json.criteria.0.weight' });
    const reasons: Record<string, string> = {
      PACKAGE_STATE_INVALID: 'packageState',
      CRITERIA_STATE_INVALID: 'stateInvalid',
      CRITERIA_LOCKED_BY_RUN: 'lockedByRun',
      SELF_APPROVAL_DENIED: 'selfApproval',
      VERSION_CONFLICT: 'versionConflict',
      FIELD_NOT_ALLOWED: 'validation',
      INVALID_REQUEST: 'validation',
      RESOURCE_NOT_FOUND: 'notFound',
      SCOPE_DENIED: 'denied',
      PERMISSION_DENIED: 'denied',
      SOMETHING_ELSE: 'general',
    };
    for (const [code, reason] of Object.entries(reasons)) expect(describeProblem(problem(code)).reason).toBe(reason);
    expect(describeProblem(new Error('offline'))).toEqual({ reason: 'general', field: undefined, weightsSum: undefined, criterionCode: undefined, legalBasis: undefined });
  });
});
