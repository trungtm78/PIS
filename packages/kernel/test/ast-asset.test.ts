import type { DomainError } from '../src/errors';
import { ASSET_STATUSES, assertAssetTransfer, assertValueWithinContract, countsTowardsContract } from '../src/ast-asset';

const failure = (work: () => unknown): DomainError => {
  try {
    work();
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('expected a refusal');
};

describe('the assets of a work (ST-AST-002, BR-AST-02, UAT-AC389)', () => {
  it('transfers only an asset that is registered', () => {
    expect(() => assertAssetTransfer('REGISTERED')).not.toThrow();
    for (const status of ASSET_STATUSES.filter((candidate) => candidate !== 'REGISTERED')) {
      expect(failure(() => assertAssetTransfer(status))).toMatchObject({ code: 'ASSET_STATE_INVALID', status: 409, extensions: { status } });
    }
  });

  it('counts every asset that was not disposed of towards the value of the contract', () => {
    expect(ASSET_STATUSES.filter((status) => countsTowardsContract(status))).toEqual(['DRAFT', 'REGISTERED', 'TRANSFERRED', 'IN_OPERATION']);
  });

  it('registers an asset worth what is left of the contract, and refuses one worth a dong more', () => {
    expect(() => assertValueWithinContract('10000000000', '5000000000', '5000000000')).not.toThrow();
    expect(() => assertValueWithinContract('10000000000', '0', '10000000000')).not.toThrow();
    expect(() => assertValueWithinContract('10000000000', '0', '0')).not.toThrow();
    expect(failure(() => assertValueWithinContract('10000000000', '5000000000', '5000000001'))).toMatchObject({
      code: 'VALUE_EXCEEDS_CONTRACT',
      status: 422,
      detail: 'value_vnd',
      extensions: { contract_value_vnd: '10000000000', registered_vnd: '5000000000', value_vnd: '5000000001', total_vnd: '10000000001' },
    });
  });
});
