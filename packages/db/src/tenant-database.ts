import { parseTenantContext } from '@machvon/kernel';
import type { TenantContext } from '@machvon/kernel';
import type { Pool, PoolClient } from 'pg';

/** The only handle work receives inside a tenant transaction; queries are always parameterised. */
export interface TenantTx {
  query<R>(sql: string, params?: unknown[]): Promise<R[]>;
}

class ClientTx implements TenantTx {
  private readonly client: PoolClient;

  constructor(client: PoolClient) {
    this.client = client;
  }

  async query<R>(sql: string, params?: unknown[]): Promise<R[]> {
    const result = await this.client.query(sql, params);
    return result.rows as R[];
  }
}

/** Rolls back and returns undefined, or returns the failure when the connection must be discarded. */
async function rollback(client: PoolClient): Promise<Error | undefined> {
  try {
    await client.query('ROLLBACK');
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error('tenant transaction rollback failed');
  }
}

/**
 * Runs work in one transaction on a pooled connection. With a tenant id the transaction-local `app.tenant_id`
 * setting is set first, so the row-level-security predicate sees that tenant and the setting can never outlive the
 * transaction (commit, rollback and thrown errors all clear it). The caller validates the id before this is called:
 * an invalid id must never reach the database.
 */
export async function runInTransaction<T>(pool: Pool, tenantId: string | undefined, work: (tx: TenantTx) => Promise<T>, begin = 'BEGIN'): Promise<T> {
  const client = await pool.connect();
  let discard: Error | undefined;
  // A backend killed while the client is checked out is reported as an 'error' event; without a listener it
  // would crash the process. The connection is then unusable and is destroyed instead of returned to the pool.
  const onClientError = (error: Error): void => {
    discard = error;
  };
  client.on('error', onClientError);
  try {
    await client.query(begin);
    if (tenantId !== undefined) await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await work(new ClientTx(client));
    await client.query('COMMIT');
    return result;
  } catch (error) {
    discard = (await rollback(client)) ?? discard;
    throw error;
  } finally {
    client.off('error', onClientError);
    // Passing an error destroys the connection instead of returning it to the pool.
    client.release(discard);
  }
}

/** Runs work inside one tenant transaction (see runInTransaction). */
export class TenantDatabase {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async withTenant<T>(ctx: TenantContext, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    // Validate before any connection is taken.
    const { tenantId } = parseTenantContext(ctx);
    return await runInTransaction(this.pool, tenantId, work);
  }

  /**
   * Runs work in one read-only transaction at REPEATABLE READ: every query sees the database as it was when the first one ran, so a set of tables read one after the other is a consistent picture of the tenant
   * (the snapshot of an export, SAS.md 3.10). Nothing can be written in it.
   */
  async withSnapshot<T>(ctx: TenantContext, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    const { tenantId } = parseTenantContext(ctx);
    return await runInTransaction(this.pool, tenantId, work, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  }
}
