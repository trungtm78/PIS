import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { CV1, CV2, cell, compared, comparison, criterion, decided, excluded } from './test-support';
import { cellOf, hasTable, isUuid, packageFromParam, readFailure, toComparison, validateVersion, versionFromParam } from './model';
import type { Comparison } from './model';

const problem = (code: string, status: number): ApiError => new ApiError({ status, code, correlationId: 'c', extensions: {} });
const read = (overrides: Record<string, unknown> = {}): Comparison => toComparison(comparison(overrides)) as Comparison;

describe('the comparison of proposals: model (ST-BID-010)', () => {
  describe('reading the comparison', () => {
    it('reads the version used, the proposals in the order given, the criteria with their cells, what was left out and the attributes never compared', () => {
      const result = read({ excluded_criteria: [{ code: 'C9', rule: 'GENDER' }] });
      expect(result).toMatchObject({ packageId: comparison().package.id, packageCode: 'GT-1', criteriaVersionId: CV2, criteriaStatus: 'APPROVED' });
      expect(result.proposals.map((proposal) => proposal.contractor.name)).toEqual(['Công ty nhà thầu 1', 'Công ty nhà thầu 2']);
      expect(result.proposals[0]).toMatchObject({ decidedCount: 2, criteriaCount: 3, mandatoryNotMet: 0, weightedScore: null });
      expect(result.rows.map((row) => row.criterion.code)).toEqual(['C1', 'C2', 'C3']);
      expect(result.rows[0]?.criterion).toMatchObject({ kind: 'PASS_FAIL', weight: null, maxScore: null, mandatory: true });
      expect(result.rows[1]?.criterion).toMatchObject({ kind: 'SCORED', weight: 40, maxScore: 10, threshold: 6, mandatory: false });
      expect(result.rows[1]?.cells[0]).toMatchObject({ findingId: expect.any(String), risk: 'NONE', decided: { status: 'SUPPORTED', score: '7.50', decision: 'ACCEPTED_WITH_CHANGE' } });
      expect(result.excluded[0]).toMatchObject({ reason: 'CRITERIA_VERSION_MISMATCH', criteriaVersionId: CV1 });
      expect(result.excludedCriteria).toEqual([{ code: 'C9', rule: 'GENDER' }]);
      expect(result.excludedAttributes).toContain('LOCAL_PRESENCE');
    });

    it('keeps the order of the proposals as the server gave it, whatever their scores are', () => {
      const result = read({ proposals: [compared(2, { weighted_score: '10.00' }), compared(1, { weighted_score: '90.00' })] });
      expect(result.proposals.map((proposal) => proposal.weightedScore)).toEqual(['10.00', '90.00']);
    });

    it('reads nothing from an answer that does not name the package and the version', () => {
      expect(toComparison(null)).toBeUndefined();
      expect(toComparison({})).toBeUndefined();
      expect(toComparison({ package: { id: 'p' } })).toBeUndefined();
      expect(toComparison({ criteria_version_id: CV2 })).toBeUndefined();
    });

    it('leaves out what is not a proposal, a criterion, a cell or a reason, and tolerates missing lists', () => {
      const result = read({
        proposals: [compared(1), { proposal_id: 'x' }, { ...compared(2), contractor: null }, { ...compared(3), run_id: null }],
        rows: [{ criterion: { code: 'C1' }, cells: [] }, { criterion: criterion('C1', { kind: 'OTHER' }), cells: [] }, { criterion: criterion('C2'), cells: [cell(1), { finding_id: 'f' }] }, null],
        excluded: [excluded(1, { reason: 'SOMETHING' }), excluded(2, { contractor: {} }), { ...excluded(3), proposal_id: null }, excluded(4)],
        excluded_criteria: [{ code: 'C9' }, { rule: 'AGE' }, { code: 'C8', rule: 'AGE' }],
        excluded_attributes: ['AGE', 1, null],
      });
      expect(result.proposals).toHaveLength(1);
      expect(result.rows.map((row) => row.criterion.code)).toEqual(['C2']);
      expect(result.rows[0]?.cells).toHaveLength(1);
      expect(result.excluded).toHaveLength(1);
      expect(result.excludedCriteria).toEqual([{ code: 'C8', rule: 'AGE' }]);
      expect(result.excludedAttributes).toEqual(['AGE']);
      const bare = toComparison({ package: { id: 'p' }, criteria_version_id: CV2 }) as Comparison;
      expect(bare).toMatchObject({ packageCode: '', criteriaStatus: '', proposals: [], rows: [], excluded: [], excludedCriteria: [], excludedAttributes: [] });
    });

    it('does not take a cell for a decision unless it says status, decision and moment, and then it is undecided whatever its risk says', () => {
      const result = read({
        rows: [
          {
            criterion: criterion('C1'),
            cells: [
              cell(1, { decided: { status: 'SUPPORTED', score: null, decision: 'ACCEPTED' }, risk: 'NONE' }),
              cell(2, { decided: { status: 'DONE', score: null, decision: 'ACCEPTED', decided_at: 'x' }, risk: 'NONE' }),
              cell(3, { decided: { status: 'SUPPORTED', score: null, decision: 'BUY', decided_at: 'x' }, risk: 'NONE' }),
              cell(4, { decided: null, risk: 'ATTENTION' }),
            ],
          },
        ],
      });
      expect(result.rows[0]?.cells.map((one) => one.risk)).toEqual(['UNDECIDED', 'UNDECIDED', 'UNDECIDED', 'UNDECIDED']);
    });

    it('takes a risk the server did not name for one that needs attention, once a person decided', () => {
      const result = read({ rows: [{ criterion: criterion('C1'), cells: [cell(1, { decided: decided('SUPPORTED', null), risk: 'UNKNOWN' })] }] });
      expect(result.rows[0]?.cells[0]?.risk).toBe('ATTENTION');
    });

    it('finds the cell of a proposal in a row, and has a table only when a proposal and a criterion are there', () => {
      const result = read();
      const row = result.rows[0] as NonNullable<(typeof result.rows)[number]>;
      expect(cellOf(row, result.proposals[0]?.proposalId as string)?.risk).toBe('NONE');
      expect(cellOf(row, 'unknown')).toBeUndefined();
      expect(hasTable(result)).toBe(true);
      expect(hasTable(read({ proposals: [] }))).toBe(false);
      expect(hasTable(read({ rows: [] }))).toBe(false);
    });
  });

  describe('what is asked', () => {
    it('takes the package and the version of the criteria from the address only when they are identities, in lower case', () => {
      expect(isUuid(CV1)).toBe(true);
      expect(isUuid('abc')).toBe(false);
      expect(packageFromParam(CV1.toUpperCase())).toBe(CV1);
      expect(packageFromParam('abc')).toBe('');
      expect(packageFromParam(null)).toBe('');
      expect(versionFromParam(` ${CV2.toUpperCase()} `)).toBe(CV2);
      expect(versionFromParam('abc')).toBe('');
      expect(versionFromParam(null)).toBe('');
    });

    it('accepts no version, which is the one in force, or an identity, and refuses any other text', () => {
      expect(validateVersion('')).toBeUndefined();
      expect(validateVersion('   ')).toBeUndefined();
      expect(validateVersion(CV1)).toBeUndefined();
      expect(validateVersion('CV-2')).toBe('notIdentity');
    });
  });

  describe('why there is no comparison to show', () => {
    it('tells the package that does not exist for the caller, the declaration that is owed, and the version that is not of the package; the rest is for the standard states', () => {
      expect(readFailure(problem('RESOURCE_NOT_FOUND', 404))).toBe('notFound');
      expect(readFailure(problem('CONFLICT_UNDECLARED', 403))).toBe('undeclared');
      expect(readFailure(problem('VALIDATION_FAILED', 422))).toBe('version');
      expect(readFailure(problem('SCOPE_DENIED', 403))).toBeUndefined();
      expect(readFailure(problem('SESSION_EXPIRED', 401))).toBeUndefined();
      expect(readFailure(new Error('down'))).toBeUndefined();
    });
  });
});
