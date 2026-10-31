import { randomUUID } from 'node:crypto';
import type { AuditWriter } from './audit-writer.ts';
import { DATA_PRODUCT_RESOURCE, DgvProductStore } from './dgv-product-store.ts';
import { enqueueOutbox } from './outbox.ts';
import type { TenantTx } from './tenant-database.ts';
import { NOOP_METRICS } from '@machvon/kernel';
import type { MetricsSink } from '@machvon/kernel';

export const PRODUCT_CERT_EXPIRED_EVENT = 'dgv.product.expired.v1';
export const PRODUCT_CERT_EXPIRED_METRIC = 'dgv_product_cert_expired_total';

export interface DgvProductExpirySummary {
  expired: number;
}

/**
 * The expiry of the certifications of the data products of a tenant (DGV.md F9, UAT-AC495): a product that is CERTIFIED and whose last day has gone becomes PROVISIONAL, once, its owner is told and BI is told
 * through the event (the badge it shows follows). Running it again, or every hour, announces nothing twice.
 */
export class DgvProductExpiryJob {
  private readonly products = new DgvProductStore();

  private readonly audit: AuditWriter;
  private readonly metrics: MetricsSink;

  constructor(audit: AuditWriter, metrics: MetricsSink = NOOP_METRICS) {
    this.audit = audit;
    this.metrics = metrics;
  }

  async run(tx: TenantTx, actor: string, now: Date): Promise<DgvProductExpirySummary> {
    const tenantId = (await tx.query<{ tenant_id: string }>("select nullif(current_setting('app.tenant_id', true), '') as tenant_id"))[0]?.tenant_id ?? '';
    const lapsed = await this.products.expire(tx, now, actor);
    for (const product of lapsed) {
      const correlationId = randomUUID();
      await this.audit.recordInTx(tx, actor, {
        action: 'dgv.product_certification_expired',
        resourceType: DATA_PRODUCT_RESOURCE,
        resourceId: product.id,
        reason: 'certification_expired',
        diff: { code: product.code, from: 'CERTIFIED', to: 'PROVISIONAL', expired_on: product.expiredOn },
        correlationId,
        requestId: correlationId,
      });
      await enqueueOutbox(tx, {
        aggregateType: DATA_PRODUCT_RESOURCE,
        aggregateId: product.id,
        aggregateVersion: product.version,
        type: PRODUCT_CERT_EXPIRED_EVENT,
        schemaVersion: 1,
        payload: {
          tenant_id: tenantId,
          product_id: product.id,
          code: product.code,
          status: 'PROVISIONAL',
          expired_on: product.expiredOn,
          occurred_at: now.toISOString(),
          notification: { resource: { type: DATA_PRODUCT_RESOURCE, id: product.id }, deepLink: `/dgv/dgv-18?product=${product.id}`, recipients: [product.ownerId] },
        },
        eventKey: `${DATA_PRODUCT_RESOURCE}:${product.id}:expired:${product.version}`,
        correlationId,
      });
      this.metrics.increment(PRODUCT_CERT_EXPIRED_METRIC);
    }
    return { expired: lapsed.length };
  }
}
