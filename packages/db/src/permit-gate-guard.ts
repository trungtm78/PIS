import { DomainError } from '@machvon/kernel';
import type { PmtGateStore } from './pmt-gate-store.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * The gate of the permits as the commands of the construction answer it: a project whose gate is BLOCKED takes no work done, no inspection and no diary, and is refused with 422
 * `PERMIT_GATE_BLOCKED` naming the gate and the rules that block (UAT-AC369). `PmtGateStore.assertPasses` answers 409 to the commands that cannot go on at all; these are refused as invalid
 * for the state of the project, so they say 422.
 */
export async function assertGateOpen(gates: Pick<PmtGateStore, 'assertPasses'>, tx: TenantTx, projectId: string, gateCode: string, today: string): Promise<void> {
  try {
    await gates.assertPasses(tx, projectId, gateCode, today);
  } catch (error) {
    if (error instanceof DomainError && error.code === 'PERMIT_GATE_BLOCKED') throw new DomainError('PERMIT_GATE_BLOCKED', 422, error.detail, { extensions: error.extensions });
    throw error;
  }
}
