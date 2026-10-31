import { randomUUID } from 'node:crypto';
import { NOOP_METRICS, vietnamDateOf } from '@machvon/kernel';
import type { ClaimSeverity, MetricsSink } from '@machvon/kernel';
import type { AuditWriter } from './audit-writer.ts';
import { AstClaimStore, WARRANTY_CLAIM_RESOURCE } from './ast-claim-store.ts';
import { enqueueOutbox } from './outbox.ts';
import type { TenantTx } from './tenant-database.ts';

export const WARRANTY_CLAIM_OVERDUE_EVENT = 'ast.warranty_claim.overdue.v1';
export const WARRANTY_CLAIM_OVERDUE_METRIC = 'ast_warranty_claim_overdue_total';

export interface AstClaimOverdueSummary {
  flagged: number;
}

/** The severity of the issue a late claim opens: a critical defect is a critical issue, a major one a high issue, a minor one a medium issue. */
const ISSUE_SEVERITY: Readonly<Record<ClaimSeverity, string>> = { CRITICAL: 'CRITICAL', MAJOR: 'HIGH', MINOR: 'MEDIUM' };

/**
 * The warranty claims nobody answered by their day (AST 3.3, UAT-AC391): an OPEN claim whose response day is before today in Vietnam is flagged, once, and `ast.warranty_claim.overdue.v1` asks ISS for an issue
 * attributed to AST (the intake opens it and the claim keeps it). Running the pass again, or every hour, flags nothing twice.
 */
export class AstClaimOverdueJob {
  private readonly claims = new AstClaimStore();

  private readonly audit: AuditWriter;
  private readonly metrics: MetricsSink;

  constructor(audit: AuditWriter, metrics: MetricsSink = NOOP_METRICS) {
    this.audit = audit;
    this.metrics = metrics;
  }

  async run(tx: TenantTx, actor: string, now: Date): Promise<AstClaimOverdueSummary> {
    const tenantId = (await tx.query<{ tenant_id: string }>("select nullif(current_setting('app.tenant_id', true), '') as tenant_id"))[0]?.tenant_id ?? '';
    const flagged = await this.claims.flagOverdue(tx, vietnamDateOf(now), now, actor);
    for (const claim of flagged) {
      const correlationId = randomUUID();
      await this.audit.recordInTx(tx, actor, {
        action: 'ast.warranty_claim_escalated',
        resourceType: WARRANTY_CLAIM_RESOURCE,
        resourceId: claim.id,
        reason: 'response_overdue',
        diff: { claim_no: claim.claimNo, contract_id: claim.contractId, project_id: claim.projectId, severity: claim.severity, response_due_on: claim.responseDueOn },
        correlationId,
        requestId: correlationId,
      });
      await enqueueOutbox(tx, {
        aggregateType: WARRANTY_CLAIM_RESOURCE,
        aggregateId: claim.id,
        aggregateVersion: claim.version,
        type: WARRANTY_CLAIM_OVERDUE_EVENT,
        schemaVersion: 1,
        payload: {
          tenant_id: tenantId,
          claim_id: claim.id,
          source_module: 'AST',
          source_ref_id: claim.id,
          reference_code: claim.claimNo,
          project_id: claim.projectId,
          contract_id: claim.contractId,
          owner_unit_id: claim.ownerUnitId,
          severity: ISSUE_SEVERITY[claim.severity],
          response_due_on: claim.responseDueOn,
          occurred_at: now.toISOString(),
        },
        eventKey: `${WARRANTY_CLAIM_RESOURCE}:${claim.id}:overdue`,
        correlationId,
      });
      this.metrics.increment(WARRANTY_CLAIM_OVERDUE_METRIC);
    }
    return { flagged: flagged.length };
  }
}
