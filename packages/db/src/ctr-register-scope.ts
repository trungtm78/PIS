import { DomainError } from '@machvon/kernel';
import { SCOPE_FROM } from './ctr-contract-store.ts';
import type { ContractPlace, ContractScopes } from './ctr-contract-store.ts';
import type { TenantTx } from './tenant-database.ts';

/** The contract a register command answers for, held for update inside the scope of the caller. */
export interface RegisterContract {
  id: string;
  code: string;
  status: string;
  /** The day the contract began (its effective date), or null while it has none. */
  effectiveFrom: string | null;
  reach: ContractPlace;
}

interface ContractSql {
  id: string;
  code: string;
  status: string;
  effective_from: string | null;
  project_id: string;
  owner_unit_id: string;
  owner_unit_path: string;
  investor_unit_id: string | null;
  investor_unit_path: string | null;
}

export const reachOfRow = (contractId: string, row: Pick<ContractSql, 'project_id' | 'owner_unit_id' | 'owner_unit_path' | 'investor_unit_id' | 'investor_unit_path'>): ContractPlace => ({
  contractId,
  projectId: row.project_id,
  ownerUnit: { id: row.owner_unit_id, path: row.owner_unit_path },
  investorUnit: row.investor_unit_id === null || row.investor_unit_path === null ? null : { id: row.investor_unit_id, path: row.investor_unit_path },
});

const SELECT = `select c.id, c.code, c.status, c.effective_from::text as effective_from, p.id as project_id, ou.id as owner_unit_id, ou.path as owner_unit_path, iu.id as investor_unit_id, iu.path as investor_unit_path
  from ${SCOPE_FROM}`;

/**
 * A contract of the registers (claims, early warnings), locked for update inside the scope of the caller. A contract the caller can read but not change is 403 `SCOPE_DENIED`, one it cannot see is 404: the same
 * answer the other registers of CTR give. The lock serialises the commands of one contract, which is what numbers its claims and warnings without a gap.
 */
export async function lockRegisterContract(tx: TenantTx, contractId: string, scopes: ContractScopes): Promise<RegisterContract> {
  const predicate = scopes.update(2);
  const rows = await tx.query<ContractSql>(`${SELECT} where c.id = $1::uuid and ${predicate.sql} for update of c`, [contractId, ...predicate.params]);
  const row = rows[0];
  if (row === undefined) {
    const readable = scopes.read(2);
    const seen = await tx.query<{ id: string }>(`select c.id from ${SCOPE_FROM} where c.id = $1::uuid and ${readable.sql}`, [contractId, ...readable.params]);
    throw seen[0] === undefined ? new DomainError('RESOURCE_NOT_FOUND', 404) : new DomainError('SCOPE_DENIED', 403);
  }
  return { id: row.id, code: row.code, status: row.status, effectiveFrom: row.effective_from, reach: reachOfRow(contractId, row) };
}

/** The contract inside the read scope of the caller (404 for one it cannot see). */
export async function readRegisterContract(tx: TenantTx, contractId: string, read: ContractScopes['read']): Promise<RegisterContract> {
  const predicate = read(2);
  const rows = await tx.query<ContractSql>(`${SELECT} where c.id = $1::uuid and ${predicate.sql}`, [contractId, ...predicate.params]);
  const row = rows[0];
  if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
  return { id: row.id, code: row.code, status: row.status, effectiveFrom: row.effective_from, reach: reachOfRow(contractId, row) };
}

/**
 * Locks a register row (a term, a claim, a warning) for update inside the scope of the caller: `from` is the table with its alias joined to the contract `c` (and the scope tables) and `id` the row; a row
 * the caller can read but not change is 403 `SCOPE_DENIED`, one it cannot see is 404.
 */
export async function lockScopedRow<T>(tx: TenantTx, query: { columns: string; from: string; alias: string; id: string }, scopes: ContractScopes): Promise<T & { reach: ContractPlace }> {
  const predicate = scopes.update(2);
  const placeColumns = 'c.id as contract_id, p.id as project_id, ou.id as owner_unit_id, ou.path as owner_unit_path, iu.id as investor_unit_id, iu.path as investor_unit_path';
  const rows = await tx.query<T & ContractSql & { contract_id: string }>(`select ${query.columns}, ${placeColumns} from ${query.from} where ${query.alias}.id = $1::uuid and ${predicate.sql} for update of ${query.alias}`, [query.id, ...predicate.params]);
  const row = rows[0];
  if (row === undefined) {
    const readable = scopes.read(2);
    const seen = await tx.query<{ id: string }>(`select ${query.alias}.id from ${query.from} where ${query.alias}.id = $1::uuid and ${readable.sql}`, [query.id, ...readable.params]);
    throw seen[0] === undefined ? new DomainError('RESOURCE_NOT_FOUND', 404) : new DomainError('SCOPE_DENIED', 403);
  }
  return { ...(row as unknown as T), reach: reachOfRow(row.contract_id, row) };
}
