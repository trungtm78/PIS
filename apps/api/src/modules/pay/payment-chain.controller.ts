import { Controller, Get, Inject, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { BidContractorStore, PayChainStore, TenantDatabase, projectScope } from '@machvon/db';
import type { ChainNode, PaymentChain } from '@machvon/db';
import { DomainError, asUuid } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';

const READ_PERMISSION = PERMISSIONS.getPaymentChain;

const idParam = (value: unknown, field: string, required: boolean): string | undefined => {
  if (value === undefined && !required) return undefined;
  const id = typeof value === 'string' ? asUuid(value) : undefined;
  if (id === undefined) throw new DomainError('VALIDATION_FAILED', 422, field);
  return id.toLowerCase();
};

function nodeView(node: ChainNode): Record<string, unknown> {
  return {
    type: node.type,
    id: node.id,
    version: node.version,
    revision: node.revision,
    status: node.status,
    label: node.label,
    contract_id: node.contractId,
    amount_vnd: node.amountVnd,
    superseded: node.superseded,
    facts: node.facts,
  };
}

/** The chain as openapi.json exposes it (x-exposure dto): an allowlist, so a column added to a table later is not shown until it is listed here. */
export function chainView(chain: PaymentChain, now: Date): Record<string, unknown> {
  return {
    project_id: chain.projectId,
    contract_id: chain.contractId,
    nodes: chain.nodes.map(nodeView),
    edges: chain.edges.map((edge) => ({ from: edge.from, to: edge.to, relation: edge.relation })),
    totals: { counted_requests: chain.totals.countedRequests, counted_gross_vnd: chain.totals.countedGrossVnd, settled_gross_vnd: chain.totals.settledGrossVnd },
    truncated: chain.truncated,
    as_of: now.toISOString(),
  };
}

/**
 * The trace of a payment from the project to its settlement (ST-PAY-010, PAY-17, UAT-AC67): read only, inside the scope of the caller over the project (`payment.chain.read`). A project of another tenant,
 * one outside the scope, a contract that is not the project's, and any request from a contractor who is a guest of the tenant are all the same answer: 404, which says nothing about what exists.
 */
@Controller()
export class PaymentChainController {
  private readonly chains = new PayChainStore();
  private readonly contractors = new BidContractorStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('payment-chain')
  @OperationId('getPaymentChain')
  async chain(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('project_id') projectId?: unknown,
    @Query('contract_id') contractId?: unknown,
  ): Promise<Record<string, unknown>> {
    const project = idParam(projectId, 'project_id', true) as string;
    const contract = idParam(contractId, 'contract_id', false);
    const now = new Date();
    const chain = await this.database.withTenant(tenant, async (tx) => {
      // The chain shows the contract, the payments and the Treasury: nothing of it is a contractor's to read.
      if ((await this.contractors.callerOf(tx, tenant.membershipId)).guest) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      return this.chains.read(tx, projectScope(access, READ_PERMISSION, now), { projectId: project, contractId: contract });
    });
    return chainView(chain, now);
  }
}
