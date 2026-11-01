import { randomUUID } from 'node:crypto';
import { NOOP_METRICS } from '@machvon/kernel';
import type { MetricsSink } from '@machvon/kernel';
import type { AuditWriter } from './audit-writer.ts';
import { DgvMaturityStore, MATURITY_ASSESSMENT_RESOURCE, MATURITY_MILESTONE_RESOURCE } from './dgv-maturity-store.ts';
import { enqueueOutbox } from './outbox.ts';
import type { TenantTx } from './tenant-database.ts';

export const MATURITY_EVIDENCE_EXPIRED_EVENT = 'dgv.evidence.expired.v1';
export const MATURITY_MILESTONE_MISSED_EVENT = 'dgv.maturity.milestone_missed.v1';
export const MATURITY_EVIDENCE_EXPIRED_METRIC = 'dgv_maturity_evidence_expired_total';
export const MATURITY_MILESTONE_MISSED_METRIC = 'dgv_maturity_milestone_missed_total';

export interface DgvMaturitySummary {
  evidenceExpired: number;
  milestonesMissed: number;
}

/**
 * The days that go by in the maturity of data governance (DGV.md F8, UAT-AC492, UAT-AC494), once for each thing: the evidence of an assessment that is still being worked on that has run out is NOT_ASSESSED again and
 * the assessor is told which criteria need new evidence; a milestone whose day has gone by without a published assessment that proves it is MISSED and its owner is told. Running it again, or every hour, announces
 * nothing twice, and a published assessment keeps the score it was published with.
 */
export class DgvMaturityJob {
  private readonly maturity = new DgvMaturityStore();

  private readonly audit: AuditWriter;
  private readonly metrics: MetricsSink;

  constructor(audit: AuditWriter, metrics: MetricsSink = NOOP_METRICS) {
    this.audit = audit;
    this.metrics = metrics;
  }

  async run(tx: TenantTx, actor: string, now: Date): Promise<DgvMaturitySummary> {
    const tenantId = (await tx.query<{ tenant_id: string }>("select nullif(current_setting('app.tenant_id', true), '') as tenant_id"))[0]?.tenant_id ?? '';
    const lapsed = await this.maturity.expireEvidence(tx);
    for (const item of lapsed) {
      const correlationId = randomUUID();
      await this.audit.recordInTx(tx, actor, {
        action: 'dgv.maturity_evidence_expired',
        resourceType: MATURITY_ASSESSMENT_RESOURCE,
        resourceId: item.assessmentId,
        reason: 'evidence_expired',
        diff: { period_code: item.periodCode, expired: item.expired, criteria: item.criteria },
        correlationId,
        requestId: correlationId,
      });
      await enqueueOutbox(tx, {
        aggregateType: MATURITY_ASSESSMENT_RESOURCE,
        aggregateId: item.assessmentId,
        aggregateVersion: item.version,
        type: MATURITY_EVIDENCE_EXPIRED_EVENT,
        schemaVersion: 1,
        payload: {
          tenant_id: tenantId,
          assessment_id: item.assessmentId,
          period_code: item.periodCode,
          criteria: item.criteria,
          occurred_at: now.toISOString(),
          notification: { resource: { type: MATURITY_ASSESSMENT_RESOURCE, id: item.assessmentId }, deepLink: `/dgv/dgv-16?assessment=${item.assessmentId}`, recipients: [item.assessorId] },
        },
        eventKey: `${MATURITY_ASSESSMENT_RESOURCE}:${item.assessmentId}:evidence_expired:${item.criteria.join(',')}:${now.toISOString().slice(0, 10)}`,
        correlationId,
      });
      for (let counted = 0; counted < item.expired; counted += 1) this.metrics.increment(MATURITY_EVIDENCE_EXPIRED_METRIC);
    }
    const missed = await this.maturity.missMilestones(tx, actor);
    for (const milestone of missed) {
      const correlationId = randomUUID();
      await this.audit.recordInTx(tx, actor, {
        action: 'dgv.maturity_milestone_missed',
        resourceType: MATURITY_MILESTONE_RESOURCE,
        resourceId: milestone.id,
        reason: 'milestone_missed',
        diff: { pillar_code: milestone.pillarCode, target_level: milestone.targetLevel, due_on: milestone.dueOn },
        correlationId,
        requestId: correlationId,
      });
      await enqueueOutbox(tx, {
        aggregateType: MATURITY_MILESTONE_RESOURCE,
        aggregateId: milestone.id,
        aggregateVersion: milestone.version,
        type: MATURITY_MILESTONE_MISSED_EVENT,
        schemaVersion: 1,
        payload: {
          tenant_id: tenantId,
          milestone_id: milestone.id,
          pillar_code: milestone.pillarCode,
          target_level: milestone.targetLevel,
          due_on: milestone.dueOn,
          occurred_at: now.toISOString(),
          notification: { resource: { type: MATURITY_MILESTONE_RESOURCE, id: milestone.id }, deepLink: `/dgv/dgv-17?milestone=${milestone.id}`, recipients: [milestone.ownerId] },
        },
        eventKey: `${MATURITY_MILESTONE_RESOURCE}:${milestone.id}:missed:${milestone.version}`,
        correlationId,
      });
      this.metrics.increment(MATURITY_MILESTONE_MISSED_METRIC);
    }
    return { evidenceExpired: lapsed.reduce((sum, item) => sum + item.expired, 0), milestonesMissed: missed.length };
  }
}
