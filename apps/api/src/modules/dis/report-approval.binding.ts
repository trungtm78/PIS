import { Inject, Injectable, Optional } from '@nestjs/common';
import { DisReportStore } from '@machvon/db';
import type { FinalCommand, ScopeBuilder } from '@machvon/db';
import { DomainError, NOOP_METRICS, REPORT_ACCEPT_BUSINESS_TYPE, REPORT_WORKFLOW_RESOURCE, message } from '@machvon/kernel';
import type { DecisionInput, MetricsSink } from '@machvon/kernel';
import { APPROVAL_FINAL_COMMANDS } from '../adm/approval.service';
import type { FinalCommandRegistry } from '../adm/approval.service';
import { applyReportDecision } from './report-decision.core';
import { DIS_CLOCK, DIS_METRICS } from './tokens';

/** A return that the workflow decides names no items of its own: the reason is the one item, due three days after the decision. */
const RETURN_DUE_DAYS = 3;
const DAY_MS = 86_400_000;
const EVERYTHING: ScopeBuilder = () => ({ sql: 'true', params: [] });

/**
 * The final command of the business type `report.accept` (R14): what the engine calls when the last step of an instance approves, or an approver returns the report. It is the decision of the report itself
 * (`applyReportDecision`), run in the transaction of the decision of the task with the audit trail and the events of that transaction. The report has to be one the decision leads from (the table of its
 * states is the guard, BR-ADM-07): when it refuses, or the outcome is one the report has no state for (a rejection), the answer is `GUARD_REJECTED` and the report is left as it was.
 */
export function reportAcceptHandler(options: { clock: () => Date; metrics: MetricsSink }): FinalCommand {
  const reports = new DisReportStore();
  return async ({ tx, instance, outcome, effects }) => {
    if (instance.resourceType !== REPORT_WORKFLOW_RESOURCE || outcome === 'REJECTED') return 'GUARD_REJECTED';
    const head = await reports.lockHead(tx, instance.resourceId);
    if (head === undefined) return 'GUARD_REJECTED';
    const detail = await reports.find(tx, head.id, EVERYTHING);
    if (detail === undefined) return 'GUARD_REJECTED';
    const [decided] = await tx.query<{ reason: string | null }>('select reason from machvon.approval_task where workflow_instance_id = $1::uuid and decision_seq = $2::integer and status = \'Decided\' limit 1', [instance.id, instance.decisionSeq]);
    const [tenant] = await tx.query<{ tenant_id: string }>("select nullif(current_setting('app.tenant_id', true), '') as tenant_id");
    const now = options.clock();
    const reason = decided?.reason ?? '';
    const input: DecisionInput =
      outcome === 'APPROVED'
        ? { decision: 'approve', reason: reason === '' ? message('dis.workflow.default_approval_reason') : reason, evidenceIds: [], returnItems: [], dueAt: null }
        : { decision: 'return', reason, evidenceIds: [], returnItems: [reason], dueAt: new Date(now.getTime() + RETURN_DUE_DAYS * DAY_MS) };
    try {
      reports.assertDecidable(head, input, effects.actor);
    } catch (error) {
      if (error instanceof DomainError) return 'GUARD_REJECTED';
      throw error;
    }
    await applyReportDecision(
      reports,
      tx,
      {
        tenantId: tenant?.tenant_id ?? '',
        actor: effects.actor,
        audit: (entry) => effects.audit(entry),
        emit: (event) => effects.emit(event),
        // A job that is not a command has no commit to wait for: the counter is moved at once.
        afterCommit: (callback) => (effects.afterCommit === undefined ? void callback() : effects.afterCommit(callback)),
      },
      { head, detail },
      input,
      now,
      options.metrics,
    );
    return 'APPLIED';
  };
}

/** Binds the final command of `report.accept` into the registry of the approval engine when the application starts, so that the boot guard of ADM finds a real handler for the business type DIS owns. */
@Injectable()
export class DisReportApprovalBinding {
  constructor(
    @Optional() @Inject(APPROVAL_FINAL_COMMANDS) commands?: FinalCommandRegistry,
    @Optional() @Inject(DIS_CLOCK) clock?: () => Date,
    @Optional() @Inject(DIS_METRICS) metrics?: MetricsSink,
  ) {
    commands?.register(REPORT_ACCEPT_BUSINESS_TYPE, reportAcceptHandler({ clock: clock ?? ((): Date => new Date()), metrics: metrics ?? NOOP_METRICS }));
  }
}
