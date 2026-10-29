import { DomainError } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

/**
 * Runs `work` while the transaction of a control-plane command acts as `tenantId` (so what it reads, writes, audits and emits belongs to that tenant), then acts as
 * `restoreTenantId` again (the platform tenant of the command). A tenant that does not exist is a plain 404, before anything is read for it.
 */
export async function actingAsTenant<T>(tx: TenantTx, tenantId: string, restoreTenantId: string, work: () => Promise<T>): Promise<T> {
  const known = await tx.query('select 1 from machvon.tenant where id = $1::uuid', [tenantId]);
  if (known.length === 0) throw new DomainError('RESOURCE_NOT_FOUND', 404);
  await tx.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
  try {
    return await work();
  } finally {
    // Also when the work is refused: a caller that goes on with the transaction after a refusal must be back in its own tenant. If the transaction itself is broken the restore fails too, and the refusal stands.
    await tx.query("select set_config('app.tenant_id', $1, true)", [restoreTenantId]).catch(() => undefined);
  }
}

/** The tenant a subscription belongs to, or undefined (a control command that names only the subscription finds the tenant to act as through this). */
export async function tenantOfSubscription(tx: TenantTx, subscriptionId: string): Promise<string | undefined> {
  const [row] = await tx.query<{ tenant_id: string | null }>('select machvon.subscription_tenant_of($1::uuid) as tenant_id', [subscriptionId]);
  return row?.tenant_id ?? undefined;
}

/** The tenant an entitlement override belongs to, or undefined (the decision and the revocation name only the override). */
export async function tenantOfOverride(tx: TenantTx, overrideId: string): Promise<string | undefined> {
  const [row] = await tx.query<{ tenant_id: string | null }>('select machvon.override_tenant_of($1::uuid) as tenant_id', [overrideId]);
  return row?.tenant_id ?? undefined;
}

/** The tenant an invoice belongs to, or undefined (the issue of an invoice names only the invoice). */
export async function tenantOfInvoice(tx: TenantTx, invoiceId: string): Promise<string | undefined> {
  const [row] = await tx.query<{ tenant_id: string | null }>('select machvon.invoice_tenant_of($1::uuid) as tenant_id', [invoiceId]);
  return row?.tenant_id ?? undefined;
}
