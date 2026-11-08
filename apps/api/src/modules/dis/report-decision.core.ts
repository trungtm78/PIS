import { DIS_DECISION_METRIC, REPORT_RESOURCE, decisionLabels } from '@machvon/db';
import type { AuditEntry, DisReportStore, OutboxEventInput, RevisionDetail, RevisionHead, TenantTx } from '@machvon/db';
import { fundingTotals } from '@machvon/kernel';
import type { DecisionInput, MetricsSink } from '@machvon/kernel';

/** The events a decision raises: an acceptance, and a return or a request for an amendment (both are a report sent back to its maker). */
const EVENT_OF = { ACCEPTED: 'report.accepted.v1', RETURNED: 'report.returned.v1', AMENDMENT_REQUESTED: 'report.returned.v1' } as const;
const AUDIT_OF = { ACCEPTED: 'dis.report_accepted', RETURNED: 'dis.report_returned', AMENDMENT_REQUESTED: 'dis.report_amendment_requested' } as const;

export type ReportDecisionOutcome = keyof typeof EVENT_OF;

/** What a decision writes beside the state of the report: the audit trail and the outbox of the transaction it runs in. A command gives its scope, a workflow its engine effects. */
export interface DecisionEffects {
  tenantId: string;
  /** The membership that decides. */
  actor: string;
  audit(entry: Omit<AuditEntry, 'correlationId' | 'requestId'>): Promise<unknown>;
  emit(event: Omit<OutboxEventInput, 'correlationId'>): Promise<unknown>;
  afterCommit(callback: () => void | Promise<void>): void;
}

/**
 * The decision of a reviewer on a weekly report that was handed in (ST-DIS-006): the one step the API command and the final command of the approval workflow both end in, so that a report decided by either leaves the
 * same state, the same audit row and the same event. The report moves along its graph, the person who handed it in is not the one who decides, the accepted revision is the current one and the one before it is
 * superseded, and the trail keeps ids, codes and counts, never the words of a reason or of an item.
 */
export async function applyReportDecision(
  reports: DisReportStore,
  tx: TenantTx,
  effects: DecisionEffects,
  target: { head: RevisionHead; detail: RevisionDetail },
  input: DecisionInput,
  now: Date,
  metrics: MetricsSink,
): Promise<{ outcome: ReportDecisionOutcome; version: number }> {
  const { head, detail } = target;
  const id = head.id;
  const done = await reports.decide(tx, head, input, effects.actor, now);
  const outcome: ReportDecisionOutcome = input.decision === 'approve' ? 'ACCEPTED' : input.decision === 'return' ? 'RETURNED' : 'AMENDMENT_REQUESTED';
  const totals = fundingTotals(detail.lines);
  await effects.audit({
    action: AUDIT_OF[outcome],
    resourceType: REPORT_RESOURCE,
    resourceId: id,
    diff: {
      project_code: detail.project.code,
      period_code: detail.period.code,
      revision: detail.revision,
      previous_status: head.status,
      decision: outcome,
      evidence_count: input.evidenceIds.length,
      items_count: input.returnItems.length,
      due_at: input.dueAt?.toISOString() ?? null,
      superseded_report_id: done.supersededId,
      payload_hash: detail.payloadHash,
      version: done.version,
    },
  });
  await effects.emit({
    aggregateType: REPORT_RESOURCE,
    aggregateId: id,
    aggregateVersion: done.version,
    type: EVENT_OF[outcome],
    schemaVersion: 1,
    payload: {
      tenant_id: effects.tenantId,
      actor_id: effects.actor,
      occurred_at: now.toISOString(),
      report_id: id,
      project_id: head.projectId,
      period_id: head.periodId,
      revision: detail.revision,
      report_type: detail.reportType,
      submitted_by: head.submittedBy,
      decision: outcome,
      decision_id: done.decisionId,
      payload_hash: detail.payloadHash,
      cumulative_vnd: totals.cumulativeVnd,
      ctmtqg_vnd: totals.ctmtqgVnd,
      ...(outcome === 'ACCEPTED' ? { accepted_at: now.toISOString(), superseded_report_id: done.supersededId } : { reason: input.reason, return_items: input.returnItems, due_at: input.dueAt?.toISOString() ?? null }),
    },
    eventKey: `${REPORT_RESOURCE}:${id}:${outcome.toLowerCase()}`,
  });
  effects.afterCommit(() => metrics.increment(DIS_DECISION_METRIC, decisionLabels(outcome)));
  return { outcome, version: done.version };
}
