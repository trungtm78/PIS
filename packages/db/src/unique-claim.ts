import { DomainError } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

const UNIQUE_VIOLATION = '23505';
const SAVEPOINT = 'unique_claim';

/** The unique constraint (or constraints) that guard a claim and the refusal that a second claim gets. */
export interface UniqueClaim {
  constraint: string | readonly string[];
  code: string;
  status?: number;
}

function violates(error: unknown, constraint: string | readonly string[]): boolean {
  const { code, constraint: violated } = (error ?? {}) as { code?: string; constraint?: string };
  return code === UNIQUE_VIOLATION && violated !== undefined && (typeof constraint === 'string' ? violated === constraint : constraint.includes(violated));
}

/**
 * Runs `work` (the insert that takes a claim, such as the one payment request an acceptance may have) inside a savepoint. When
 * the database refuses it because the unique constraint of the claim already holds a row, the savepoint is rolled back, so the
 * transaction stays usable, and the second claimer gets the stable refusal (409 by default) instead of a raw database error.
 * The claimer that was second under a race waits for the first one to commit and then lands here, so the constraint, not the
 * application, decides who wins; any other failure goes through unchanged.
 */
export async function withUniqueClaim<T>(tx: TenantTx, claim: UniqueClaim, work: () => Promise<T>): Promise<T> {
  await tx.query(`savepoint ${SAVEPOINT}`);
  try {
    const result = await work();
    await tx.query(`release savepoint ${SAVEPOINT}`);
    return result;
  } catch (error) {
    if (!violates(error, claim.constraint)) throw error;
    await tx.query(`rollback to savepoint ${SAVEPOINT}`);
    throw new DomainError(claim.code, claim.status ?? 409);
  }
}
