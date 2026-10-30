import { addDecimal, compareDecimal } from './decimal.ts';
import { DomainError } from './errors.ts';

/**
 * The assets a work produces and the guard of their value (ST-AST-002, AST 3.2, BR-AST-02): the statuses, the bases of the value, the one move an asset makes in this story (registered, then
 * transferred) and the rule that the assets of a contract never add up to more than the contract is worth. Pure functions of their input, kept apart from the database.
 */

export const ASSET_STATUSES = ['DRAFT', 'REGISTERED', 'TRANSFERRED', 'IN_OPERATION', 'DISPOSED'] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];

export const VALUE_BASES = ['CONTRACT_VALUE', 'SETTLED_VALUE', 'APPRAISED_VALUE'] as const;
export type ValueBasis = (typeof VALUE_BASES)[number];

/** An asset is transferred to the unit that operates it once, from REGISTERED: 409 `ASSET_STATE_INVALID` otherwise. */
export function assertAssetTransfer(status: AssetStatus): void {
  if (status !== 'REGISTERED') throw new DomainError('ASSET_STATE_INVALID', 409, 'id', { extensions: { status } });
}

/** The statuses of an asset that has been handed to the unit that operates it: only such an asset is linked to a plan of operation and maintenance (422 `ASSET_NOT_TRANSFERRED` otherwise). */
export const OPERATED_STATUSES: readonly AssetStatus[] = ['TRANSFERRED', 'IN_OPERATION'];

export function assertAssetOperated(status: AssetStatus): void {
  if (!OPERATED_STATUSES.includes(status)) throw new DomainError('ASSET_NOT_TRANSFERRED', 422, 'id', { extensions: { status } });
}

/** The cycle of maintenance, in whole months, from one to ten years. */
export const MAX_MAINTENANCE_CYCLE_MONTHS = 120;

/** The assets that count towards the value of a contract: every asset that was not disposed of. */
export const countsTowardsContract = (status: AssetStatus): boolean => status !== 'DISPOSED';

/**
 * The total of the assets of a contract is at most the value of the contract (BR-AST-02): 422 `VALUE_EXCEEDS_CONTRACT` with the value of the contract, what is already registered and the
 * value that was asked, all whole VND as text. An asset worth exactly what is left is registered.
 */
export function assertValueWithinContract(contractValueVnd: string, registeredVnd: string, valueVnd: string): void {
  const total = addDecimal(registeredVnd, valueVnd);
  if (compareDecimal(total, contractValueVnd) === 1) {
    throw new DomainError('VALUE_EXCEEDS_CONTRACT', 422, 'value_vnd', { extensions: { contract_value_vnd: contractValueVnd, registered_vnd: registeredVnd, value_vnd: valueVnd, total_vnd: total } });
  }
}
