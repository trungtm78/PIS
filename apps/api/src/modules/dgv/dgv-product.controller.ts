import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { DATA_PRODUCT_RESOURCE, DgvProductStore, TenantDatabase } from '@machvon/db';
import type { ProductLine } from '@machvon/db';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { assertTenantAuthority, viewerOf } from './inputs';

const CERTIFY = 'data.product.certify';
const CERTIFIED_EVENT = 'dgv.product.certified.v1';

/** The product as the contract exposes it: an allowlist. */
export function productView(line: ProductLine): Record<string, unknown> {
  return {
    id: line.id,
    code: line.code,
    title: line.title,
    owner: { membership_id: line.owner.membershipId, display_name: line.owner.displayName },
    datasets: line.datasets.map((dataset) => ({ id: dataset.id, dataset_code: dataset.datasetCode, title: dataset.title, contract_published: dataset.contractPublished, quality_badge: dataset.qualityBadge })),
    datasets_hidden: line.datasetsHidden,
    certification_status: line.status,
    certified_by: line.certifiedBy === null ? null : { membership_id: line.certifiedBy.membershipId, display_name: line.certifiedBy.displayName },
    certified_at: line.certifiedAt,
    certification_expires_on: line.expiresOn,
    evidence_count: line.evidenceCount,
    revoke_reason: line.revokeReason,
    version: line.version,
  };
}

/**
 * The certification of the data products (ST-DGV-009, DGV 3.1 F9, DGV-18, UAT-AC495): somebody other than the owner decides, against the version they read; a certification needs evidence, a last day, a published
 * contract and a passing run for every dataset of the product; the day after the last day the product is provisional again (the job `dgv-product-cert-expiry`). The read shows what stands between a product and
 * its certification.
 */
@Controller()
export class DgvProductController {
  private readonly products = new DgvProductStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Post('dgv/data-products/:id/certification')
  @HttpCode(200)
  @OperationId('certifyDataProduct')
  @Command({ operation: 'certifyDataProduct', versioned: true })
  async certify(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['DgvProductCertify']): Promise<CommandResult> {
    assertTenantAuthority(access, CERTIFY);
    const done = await this.products.certify(
      scope.tx,
      id.toLowerCase(),
      scope.expectedVersion ?? 0,
      { decision: body.decision, reason: body.reason, evidenceRefs: body.evidence_refs, expiresOn: body.certification_expires_on },
      scope.tenant.membershipId,
    );
    await scope.audit({
      action: 'dgv.product_certification_decided',
      resourceType: DATA_PRODUCT_RESOURCE,
      resourceId: done.id,
      classification: 'INTERNAL',
      reason: body.reason.trim(),
      diff: { code: done.code, from: done.previous, to: done.status, certification_expires_on: done.expiresOn, evidence_count: done.evidenceCount, dataset_ids: done.datasetIds },
    });
    await scope.emit({
      aggregateType: DATA_PRODUCT_RESOURCE,
      aggregateId: done.id,
      aggregateVersion: done.version,
      type: CERTIFIED_EVENT,
      schemaVersion: 1,
      payload: { product_id: done.id, code: done.code, status: done.status, previous_status: done.previous, certification_expires_on: done.expiresOn, dataset_ids: done.datasetIds },
      eventKey: `${DATA_PRODUCT_RESOURCE}:${done.id}:${done.version}`,
    });
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Get('dgv/data-products')
  @OperationId('listDataProducts')
  async list(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess): Promise<Record<string, unknown>> {
    const lines = await this.database.withTenant(tenant, (tx) => this.products.list(tx, viewerOf(tenant, access)));
    return { items: lines.map(productView) };
  }
}
