import { Body, Controller, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { DIS_WITHDRAWAL_METRIC, DisPeriodStore, DisReportStore, REPORT_RESOURCE, projectScope } from '@machvon/db';
import { DomainError, NOOP_METRICS, deletionOf, fundingTotals, message, restoreDeadline, withdrawRefusal, withdrawalOf } from '@machvon/kernel';
import type { EffectiveAccess, MetricsSink } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { APPROVAL_FINAL_COMMANDS, effectsOf } from '../adm/approval.service';
import type { FinalCommandRegistry } from '../adm/approval.service';
import { ReportApprovalFlow } from './report-approval.flow';
import { DIS_CLOCK, DIS_METRICS } from './tokens';

const READ_PERMISSION = PERMISSIONS.getReportRevision;
const WITHDRAW_PERMISSION = PERMISSIONS.withdrawReport;
const DELETE_PERMISSION = PERMISSIONS.deleteDraftReport;
const RESTORE_PERMISSION = PERMISSIONS.restoreDraftReport;

/**
 * The commands that undo a mistake without touching what was reviewed (ST-DIS-007, DIS 3 F3): a maker takes back a report that was handed in and is not under review, in a period that takes it, with
 * a reason of at least 20 characters; deletes a draft softly with a reason; and restores a draft that was deleted within 30 days, for a person who may edit the project now (the permission is
 * judged again, not remembered from the deletion). What was handed in and reviewed is never deleted. The trail keeps ids, codes and counts, never the words of a reason.
 */
@Controller()
export class ReportLifecycleController {
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

  @Post('reports/:id/withdrawal')
  @HttpCode(200)
  @OperationId('withdrawReport')
  @Command({ operation: 'withdrawReport', versioned: true })
  async withdraw(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['DisWithdrawal'],
  ): Promise<CommandResult> {
    const now = this.clock();
    const { reason } = withdrawalOf(body);
    const seen = projectScope(access, READ_PERMISSION, now);
    const head = await this.reports.lock(scope.tx, id, seen, projectScope(access, WITHDRAW_PERMISSION, now), scope.expectedVersion ?? 0);
    // The state of the report first, then the state of the period: the answer does not depend on which of them the caller looked at.
    const refusal = withdrawRefusal(head.status, head.deleted);
    if (refusal !== undefined) throw refusal;
    const judged = await this.periods.judge(scope.tx, head.periodId, head.projectId, now);
    const detail = await this.reports.find(scope.tx, id, seen);
    if (detail === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const actor = scope.tenant.membershipId;
    const done = await this.reports.withdraw(scope.tx, head, reason, actor, now);
    const totals = fundingTotals(detail.lines);
    await scope.audit({
      action: 'dis.report_withdrawn',
      resourceType: REPORT_RESOURCE,
      resourceId: id,
      diff: {
        project_code: detail.project.code,
        period_code: detail.period.code,
        revision: detail.revision,
        previous_status: head.status,
        reason_length: reason.length,
        payload_hash: detail.payloadHash,
        reopened: judged.reopen !== null,
        version: done.version,
      },
    });
    await scope.emit({
      aggregateType: REPORT_RESOURCE,
      aggregateId: id,
      aggregateVersion: done.version,
      type: 'report.withdrawn.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        actor_id: actor,
        occurred_at: now.toISOString(),
        report_id: id,
        project_id: head.projectId,
        period_id: head.periodId,
        revision: detail.revision,
        report_type: detail.reportType,
        submitted_by: head.submittedBy,
        withdrawn_at: now.toISOString(),
        reason,
        cumulative_vnd: totals.cumulativeVnd,
        ctmtqg_vnd: totals.ctmtqgVnd,
      },
      eventKey: `${REPORT_RESOURCE}:${id}:withdrawn`,
    });
    // A report that is taken back leaves the approval it was in: its instance ends with it, so that no approver is asked to decide on it.
    await this.flow.cancelIfRunning(scope.tx, effectsOf(scope), id, message('dis.workflow.cancel_reason.withdrawn'), now);
    scope.afterCommit(() => this.metrics.increment(DIS_WITHDRAWAL_METRIC, {}));
    return commandResult(scope, 'WITHDRAWN', done.version, id);
  }

  @Post('reports/:id/draft-deletion')
  @HttpCode(200)
  @OperationId('deleteDraftReport')
  @Command({ operation: 'deleteDraftReport', versioned: true })
  async deleteDraft(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['DisDraftDeletion'],
  ): Promise<CommandResult> {
    const now = this.clock();
    const { reason } = deletionOf(body);
    const seen = projectScope(access, READ_PERMISSION, now);
    const head = await this.reports.lock(scope.tx, id, seen, projectScope(access, DELETE_PERMISSION, now), scope.expectedVersion ?? 0);
    const detail = await this.reports.find(scope.tx, id, seen);
    if (detail === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const done = await this.reports.softDelete(scope.tx, head, reason, scope.tenant.membershipId, now);
    await scope.audit({
      action: 'dis.report_draft_deleted',
      resourceType: REPORT_RESOURCE,
      resourceId: id,
      diff: { project_code: detail.project.code, period_code: detail.period.code, revision: detail.revision, reason_length: reason.length, restorable_until: restoreDeadline(now.toISOString()).toISOString(), version: done.version },
    });
    return commandResult(scope, 'DRAFT', done.version, id);
  }

  @Post('reports/:id/draft-restore')
  @HttpCode(200)
  @OperationId('restoreDraftReport')
  @Command({ operation: 'restoreDraftReport', versioned: true })
  async restoreDraft(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    const now = this.clock();
    const seen = projectScope(access, READ_PERMISSION, now);
    // The right to edit is the one the person holds now (403 SCOPE_DENIED otherwise), whatever it was when the draft was deleted.
    const head = await this.reports.lock(scope.tx, id, seen, projectScope(access, RESTORE_PERMISSION, now), scope.expectedVersion ?? 0);
    const detail = await this.reports.find(scope.tx, id, seen);
    if (detail === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const done = await this.reports.restore(scope.tx, head, scope.tenant.membershipId, now);
    await scope.audit({
      action: 'dis.report_draft_restored',
      resourceType: REPORT_RESOURCE,
      resourceId: id,
      diff: { project_code: detail.project.code, period_code: detail.period.code, revision: detail.revision, deleted_at: head.deletedAt, version: done.version },
    });
    return commandResult(scope, 'DRAFT', done.version, id);
  }
}
