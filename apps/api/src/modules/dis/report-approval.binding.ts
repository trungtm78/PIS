import { Inject, Injectable, Optional } from '@nestjs/common';
import { DisReportStore } from '@machvon/db';
import type { FinalCommand, ScopeBuilder } from '@machvon/db';
import { DomainError, NOOP_METRICS, REPORT_ACCEPT_BUSINESS_TYPE, REPORT_WORKFLOW_RESOURCE, message } from '@machvon/kernel';
import type { DecisionInput, MetricsSink } from '@machvon/kernel';
import { APPROVAL_PUSH_SOURCES } from '../adm/approval-hold.service';
import type { ApprovalPushSource, ApprovalPushSources } from '../adm/approval-hold.service';
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

/**
 * What the PUSH step of the staged approval hands over for a weekly report (ENT-3c): the report as it was approved, keyed by its project, the last day of its period and its revision. The newest revision of the report is
 * the head the receiver judges staleness against (R17): a report corrected meanwhile makes this revision out of date.
 */
export function reportPushSource(): ApprovalPushSource {
  const reports = new DisReportStore();
  return {
    owner: 'REPORT',
    resourceType: REPORT_WORKFLOW_RESOURCE,
    layoutBase: 'DIS_WEEKLY',
    async describe(tx, instance) {
      const detail = await reports.find(tx, instance.resourceId, EVERYTHING);
      if (detail === undefined) return undefined;
      const latest = await reports.latestFor(tx, detail.projectId, detail.periodId);
      return {
        subjectCode: detail.project.code,
        period: detail.period.endDate,
        revision: detail.revision,
        headRevision: Math.max(detail.revision, latest?.revision ?? 0),
        facts: {
          project_code: detail.project.code,
          period_code: detail.period.code,
          report_type: detail.reportType,
          measurement_basis: detail.measurementBasis,
          payload_hash: detail.payloadHash,
          totals: detail.totals,
          lines: detail.lines.map((line) => ({ bucket: line.bucket, budget_level: line.budgetLevel, cumulative_vnd: line.cumulativeVnd, ctmtqg_vnd: line.ctmtqgVnd, next_month_vnd: line.nextMonthVnd })),
        },
      };
    },
  };
}

/** Binds the final command of `report.accept` into the registry of the approval engine when the application starts, so that the boot guard of ADM finds a real handler for the business type DIS owns. */
@Injectable()
export class DisReportApprovalBinding {
  constructor(
    @Optional() @Inject(APPROVAL_FINAL_COMMANDS) commands?: FinalCommandRegistry,
    @Optional() @Inject(DIS_CLOCK) clock?: () => Date,
    @Optional() @Inject(DIS_METRICS) metrics?: MetricsSink,
    @Optional() @Inject(APPROVAL_PUSH_SOURCES) sources?: ApprovalPushSources,
  ) {
    sources?.register(reportPushSource());
    commands?.register(REPORT_ACCEPT_BUSINESS_TYPE, reportAcceptHandler({ clock: clock ?? ((): Date => new Date()), metrics: metrics ?? NOOP_METRICS }));
  }
}
