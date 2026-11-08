import { Controller, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { DIS_SUBMIT_METRIC, DisPeriodStore, DisReportStore, REPORT_RESOURCE, projectScope, submitLabels } from '@machvon/db';
import { DomainError, NOOP_METRICS, fundingTotals, periodDeltaOf, submitRefusal } from '@machvon/kernel';
import type { EffectiveAccess, MetricsSink } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { assertPeriodReach } from './period-gate';
import { OperationId } from '../../operation-id.decorator';
import { APPROVAL_FINAL_COMMANDS, effectsOf } from '../adm/approval.service';
import type { FinalCommandRegistry } from '../adm/approval.service';
import { ReportApprovalFlow } from './report-approval.flow';
import { reviewOf } from './report-review';
import { DIS_CLOCK, DIS_METRICS } from './tokens';

const READ_PERMISSION = PERMISSIONS.getReportRevision;
const SUBMIT_PERMISSION = PERMISSIONS.post_reports_id_submit;
/** The kind of business the workflow of the review of a report is published for. */
const WORKFLOW_BUSINESS_TYPE = 'DIS_REPORT_REVIEW';

/**
 * The submit of a weekly report (ST-DIS-005, DIS 3 F1 step 8): one transaction that locks the report, checks the version the screen showed, the state of the period and the review of BR-DIS-07,
 * seals the content with its SHA-256, takes the time from the server, judges the lateness by the calendar the period is bound to, and writes the audit row and the event `report.submitted.v1` with the
 * report. A retry with the same key answers the first answer and changes nothing; two makers at once give one winner and a 409 \`VERSION_CONFLICT\` naming the version that won. A locked period takes
 * nothing unless an approved reopening names the project (409 \`PERIOD_LOCKED\`, the draft unchanged). Warnings do not block and come back with the answer; a fall below the period before is told with
 * the change as it is (negative, never forced to zero).
 */
@Controller()
export class ReportSubmitController {
  private readonly reports = new DisReportStore();
  private readonly periods = new DisPeriodStore();
  private readonly clock: () => Date;
  private readonly metrics: MetricsSink;
  private readonly flow: ReportApprovalFlow;

  constructor(
    @Optional() @Inject(DIS_CLOCK) clock?: () => Date,
    @Optional() @Inject(DIS_METRICS) metrics?: MetricsSink,
    @Optional() @Inject(APPROVAL_FINAL_COMMANDS) commands?: FinalCommandRegistry,
  ) {
    this.clock = clock ?? ((): Date => new Date());
    this.metrics = metrics ?? NOOP_METRICS;
    this.flow = new ReportApprovalFlow(commands);
  }

  @Post('reports/:id/submit')
  @HttpCode(200)
  @OperationId('post_reports_id_submit')
  @Command({ operation: 'post_reports_id_submit', versioned: true })
  async submit(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Schemas['DisReportSubmitResult']> {
    const now = this.clock();
    const seen = projectScope(access, READ_PERMISSION, now);
    const head = await this.reports.lock(scope.tx, id, seen, projectScope(access, SUBMIT_PERMISSION, now), scope.expectedVersion ?? 0);
    // What was handed in is not handed in twice; the answer does not wait for the period.
    this.reports.assertEditable(head);
    await assertPeriodReach(scope.tx, this.periods, head.periodId, access, SUBMIT_PERMISSION, now);
    const judged = await this.periods.judge(scope.tx, head.periodId, head.projectId, now);
    const detail = await this.reports.find(scope.tx, id, seen);
    if (detail === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const review = await reviewOf(scope.tx, this.reports, this.periods, detail, now);
    const refusal = submitRefusal(review);
    if (refusal !== undefined) throw refusal;

    const payloadHash = this.reports.hashOf(detail);
    const workflowVersionId = await this.reports.workflowVersionFor(scope.tx, WORKFLOW_BUSINESS_TYPE);
    const sealed = await this.reports.submit(scope.tx, head, { actor: scope.tenant.membershipId, at: now, late: judged.late, payloadHash, workflowVersionId });
    const totals = fundingTotals(detail.lines);
    const periodDelta = periodDeltaOf(detail.lines.map((line) => line.deltaVnd));
    await scope.audit({
      action: 'dis.report_submitted',
      resourceType: REPORT_RESOURCE,
      resourceId: id,
      diff: {
        project_code: detail.project.code,
        period_code: detail.period.code,
        revision: detail.revision,
        is_late: judged.late,
        deadline_at: judged.deadlineAt,
        payload_hash: payloadHash,
        cumulative_vnd: totals.cumulativeVnd,
        ctmtqg_vnd: totals.ctmtqgVnd,
        period_delta_vnd: periodDelta,
        warnings: review.warnings.map((finding) => finding.code),
        reopened: judged.reopen !== null,
        version: sealed.version,
      },
    });
    await scope.emit({
      aggregateType: REPORT_RESOURCE,
      aggregateId: id,
      aggregateVersion: sealed.version,
      type: 'report.submitted.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
        report_id: id,
        project_id: head.projectId,
        period_id: head.periodId,
        revision: detail.revision,
        report_type: detail.reportType,
        is_late: judged.late,
        payload_hash: payloadHash,
        submitted_at: now.toISOString(),
        cumulative_vnd: totals.cumulativeVnd,
        ctmtqg_vnd: totals.ctmtqgVnd,
      },
      eventKey: `${REPORT_RESOURCE}:${id}:submitted`,
    });
    // A tenant that runs the staged approval has the hand-in start its instance in this transaction: a refusal of the engine (no DoA rule, no approver) takes the hand-in back and the report stays a draft.
    await this.flow.startIfStaged(scope.tx, effectsOf(scope), { id, projectId: head.projectId, version: sealed.version, submittedBy: scope.tenant.membershipId, cumulativeVnd: totals.cumulativeVnd }, now);
    scope.afterCommit(() => this.metrics.increment(DIS_SUBMIT_METRIC, submitLabels(judged.late)));
    return {
      ...commandResult(scope, 'SUBMITTED', sealed.version, id),
      is_late: judged.late,
      submitted_at: now.toISOString(),
      payload_hash: payloadHash,
      period_delta_vnd: periodDelta,
      warnings: review.warnings.map((finding) => ({ code: finding.code, field: finding.field, values: finding.values })),
    } as Schemas['DisReportSubmitResult'];
  }
}
