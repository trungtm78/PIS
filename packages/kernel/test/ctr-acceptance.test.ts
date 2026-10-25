import type { DomainError } from '../src/errors';
import { WORK_ACCEPTANCE_COMMANDS, WORK_ACCEPTANCE_STATUSES, assertWithinContractValue, assertWorkAcceptanceTransition, isAccepted, lineAmount, notApproved, sumAmounts } from '../src/ctr-acceptance';

function refusal(work: () => unknown): DomainError {
  try {
    work();
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('expected a refusal');
}

describe('the acceptance of work (ST-CTR-009)', () => {
  it('moves along the edges of the life of an acceptance and nowhere else', () => {
    expect(assertWorkAcceptanceTransition('submit', 'DRAFT')).toBe('SUBMITTED');
    expect(assertWorkAcceptanceTransition('approve', 'SUBMITTED')).toBe('APPROVED');
    expect(assertWorkAcceptanceTransition('reject', 'SUBMITTED')).toBe('REJECTED');
    expect(assertWorkAcceptanceTransition('return', 'SUBMITTED')).toBe('DRAFT');
    expect(assertWorkAcceptanceTransition('revoke', 'APPROVED')).toBe('REVOKED');
    const from: Record<string, string> = { submit: 'DRAFT', approve: 'SUBMITTED', reject: 'SUBMITTED', return: 'SUBMITTED', revoke: 'APPROVED' };
    for (const command of WORK_ACCEPTANCE_COMMANDS) {
      for (const status of WORK_ACCEPTANCE_STATUSES) {
        if (from[command] === status) continue;
        const error = refusal(() => assertWorkAcceptanceTransition(command, status));
        expect(error).toMatchObject({ code: 'ACCEPTANCE_STATE_INVALID', status: 409, extensions: { acceptance_status: status } });
      }
    }
  });

  it('counts only an approved acceptance as accepted', () => {
    expect(WORK_ACCEPTANCE_STATUSES.filter(isAccepted)).toEqual(['APPROVED']);
  });

  it('AC-ST-CTR-009-1, UAT-AC63: prices a line as the quantity times the price, rounded the way the line of the BOQ is rounded', () => {
    expect(lineAmount('200.000000', '2000000.000000', 'HALF_UP')).toBe('400000000');
    expect(lineAmount('0.500000', '1.000001', 'HALF_UP')).toBe('1');
    expect(lineAmount('0.500000', '1.000001', 'DOWN')).toBe('0');
    expect(lineAmount('2.500000', '1.000000', 'HALF_EVEN')).toBe('2');
    expect(lineAmount('2.500000', '1.000000', 'HALF_UP')).toBe('3');
    expect(lineAmount('0.000001', '1.000000', 'UP')).toBe('1');
  });

  it('adds whole-dong amounts without losing a digit', () => {
    expect(sumAmounts([])).toBe('0');
    expect(sumAmounts(['400000000', '210000000'])).toBe('610000000');
    expect(sumAmounts(['999999999999999999999999', '1'])).toBe('1000000000000000000000000');
  });

  it('keeps what is accepted within the value of the contract, and says how much is left', () => {
    expect(() => assertWithinContractValue('9000000000', '1000000000', '10000000000')).not.toThrow();
    const error = refusal(() => assertWithinContractValue('9000000000', '1000000001', '10000000000'));
    expect(error).toMatchObject({ code: 'ACCEPTANCE_VALUE_EXCEEDS_CONTRACT', status: 422, extensions: { accepted_total_vnd: '9000000000', amount_vnd: '1000000001', contract_value_vnd: '10000000000', remaining_vnd: '1000000000' } });
  });

  it('names the measurements that are not approved, in the order they were asked', () => {
    expect(notApproved(['a', 'b', 'c'], new Set(['b']))).toEqual(['a', 'c']);
    expect(notApproved(['a'], new Set(['a']))).toEqual([]);
  });
});
