import { Controller, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post, Body } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { DIS_CORRECTION_METRIC, DisPeriodStore, DisReportStore, REPORT_RESOURCE, projectScope } from '@machvon/db';
import type { AttachmentFile, NewCorrection, RevisionDetail } from '@machvon/db';
import { DomainError, NOOP_METRICS, correctionOf, correctionSourceRefusal, decisionOf, fundingCells, fundingTotals, message, negativeDeltaExplanation, progressOf } from '@machvon/kernel';
import type { EffectiveAccess, FundingInput, MetricsSink, ProgressInput } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { assertPeriodReach } from './period-gate';
import { OperationId } from '../../operation-id.decorator';
import { ApprovalHoldService } from '../adm/approval-hold.service';
import { APPROVAL_FINAL_COMMANDS, effectsOf } from '../adm/approval.service';
import type { FinalCommandRegistry } from '../adm/approval.service';
import { ReportApprovalFlow } from './report-approval.flow';
import { applyReportDecision } from './report-decision.core';
import type { DecisionEffects } from './report-decision.core';
import { DIS_CLOCK, DIS_METRICS } from './tokens';

const READ_PERMISSION = PERMISSIONS.getReportRevision;
const DECISION_PERMISSION = PERMISSIONS.post_reports_id_decision;
const CORRECTION_PERMISSION = PERMISSIONS.post_reports_id_corrections;

/** What a decision writes, as the scope of the command gives it. */
const decisionEffectsOf = (scope: CommandScope): DecisionEffects => ({
  tenantId: scope.tenant.tenantId,
  actor: scope.tenant.membershipId,
  audit: (entry) => scope.audit(entry),
  emit: (event) => scope.emit(event),
  afterCommit: (callback) => scope.afterCommit(callback),
});

const cellOf = (row: RevisionDetail['lines'][number]): FundingInput => ({
  bucket: row.bucket,
  budgetLevel: row.budgetLevel,
  cumulativeVnd: row.cumulativeVnd,
  ctmtqgVnd: row.ctmtqgVnd,
  nextMonthVnd: row.nextMonthVnd,
  nextMonthCtmtqgVnd: row.nextMonthCtmtqgVnd,
  sourceYear: row.sourceYear,
});

/**
 * What a correction carries over from the report it corrects, with what the request names in its place: the cells it names replace the same cells (the others stay as they were), the volumes it
 * names replace the volumes, the explanation of a fall it names replaces the explanation. The narrative and the files are carried over as they were.
 */
function carriedOver(source: RevisionDetail, body: Schemas['DisReportCorrection']): { cells: FundingInput[]; explanation: string | null; progress: ProgressInput | null } {
  const kept = new Map(source.lines.map((row) => [`${row.bucket}/${row.budgetLevel}`, row]));
  // A cell the request names is replaced as a whole, except for what it leaves out of the registration for next month and of the year of its source, which are the ones the report had.
  const completed = (body.funding_lines ?? []).map((line) => {
    const before = kept.get(`${line.bucket}/${line.budget_level}`);
    return {
      ...line,
      ...(line.next_month_vnd === undefined && before !== undefined ? { next_month_vnd: before.nextMonthVnd } : {}),
      ...(line.next_month_ctmtqg_subset_vnd === undefined && before?.nextMonthCtmtqgVnd != null ? { next_month_ctmtqg_subset_vnd: before.nextMonthCtmtqgVnd } : {}),
      ...(line.source_year === undefined && before?.sourceYear != null ? { source_year: before.sourceYear } : {}),
    };
  });
  const named = fundingCells(completed);
  const namedKeys = new Set(completed.map((line) => `${line.bucket}/${line.budget_level}`));
  const replaced = new Map(named.filter((cell) => namedKeys.has(`${cell.bucket}/${cell.budgetLevel}`)).map((cell) => [`${cell.bucket}/${cell.budgetLevel}`, cell]));
  const cells = source.lines.map((row) => replaced.get(`${row.bucket}/${row.budgetLevel}`) ?? cellOf(row));
  const volumes = body.progress === undefined ? undefined : progressOf(body.progress as Parameters<typeof progressOf>[0]);
  const progress: ProgressInput | null =
    volumes ??
    (source.progress === null
      ? null
      : {
          constructionVnd: source.progress.constructionVnd,
          acceptanceVnd: source.progress.acceptanceVnd,
          treasurySubmittedVnd: source.progress.treasurySubmittedVnd,
          preparingDossierVnd: source.progress.preparingDossierVnd,
          physicalProgressPct: source.progress.physicalProgressPct,
        });
  const explanation = body.negative_delta_explanation === undefined ? source.negativeDeltaExplanation : negativeDeltaExplanation(body.negative_delta_explanation);
  return { cells, explanation, progress };
}

/**
 * The decision of a reviewer on a weekly report and the corrections that follow (ST-DIS-006, DIS 3 F2). A reviewer accepts, returns or asks for the amendment of a report that was handed in
 * (maker-checker: never the person who handed it in, 403 `SELF_APPROVAL_DENIED`, and the attempt is on the trail); the decision is kept as it was taken, the accepted revision is the one current and
 * the one before it is superseded in the same step. A maker answers a return, or an amendment asked for, with a new revision that points at the one it corrects and says why; the revision that was
 * handed in is never edited. The trail keeps ids, codes and counts, never the words of a reason or of an item; the events carry what a notification needs.
 */
@Controller()
export class ReportDecisionController {
  private readonly reports = new DisReportStore();
  private readonly periods = new DisPeriodStore();
  private readonly clock: () => Date;
  private readonly metrics: MetricsSink;
  private readonly flow: ReportApprovalFlow;

  constructor(
    @Optional() @Inject(DIS_CLOCK) clock?: () => Date,
    @Optional() @Inject(DIS_METRICS) metrics?: MetricsSink,
    @Optional() @Inject(APPROVAL_FINAL_COMMANDS) commands?: FinalCommandRegistry,
    @Optional() @Inject(ApprovalHoldService) holds?: ApprovalHoldService,
  ) {
    this.clock = clock ?? ((): Date => new Date());
    this.metrics = metrics ?? NOOP_METRICS;
    this.flow = new ReportApprovalFlow(commands, holds);
  }

  @Post('reports/:id/decision')
  @HttpCode(200)
  @OperationId('post_reports_id_decision')
  @Command({ operation: 'post_reports_id_decision', versioned: true })
  async decide(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['DisReportDecision'],
  ): Promise<CommandResult> {
    const now = this.clock();
    const input = decisionOf(body, now);
    const seen = projectScope(access, READ_PERMISSION, now);
    const head = await this.reports.lock(scope.tx, id, seen, projectScope(access, DECISION_PERMISSION, now), scope.expectedVersion ?? 0);
    const detail = await this.reports.find(scope.tx, id, seen);
    if (detail === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    await assertPeriodReach(scope.tx, this.reports, this.periods, head.projectId, head.periodId, access, DECISION_PERMISSION, now);
    const effects = decisionEffectsOf(scope);
    // A report with a running instance (the tenant runs the staged approval) is decided through the steps of the instance; one without is decided as it always was.
    const instance = await this.flow.runningFor(scope.tx, id);
    if (instance !== undefined) {
      // The refusals that come before anything is written are the same ones, in the same order, whatever the steps are.
      this.reports.assertDecidable(head, input, effects.actor);
      if (input.decision === 'approve') {
        const applied: { version: number | undefined } = { version: undefined };
        const step = await this.flow.approve(scope.tx, effectsOf(scope), instance, input, now, async () => {
          applied.version = (await applyReportDecision(this.reports, scope.tx, effects, { head, detail }, input, now, this.metrics)).version;
        }, scope.tenant.tenantId);
        // The PUSH step handed its package over: the report is decided when the receiver confirms, not before (R22).
        if (step.step === 'HELD') return commandResult(scope, step.hold?.state === 'PUSH_FAILED' ? 'PUSH_FAILED' : 'AWAITING_RECEIPT', head.version, id);
        if (step.step !== 'COMPLETED' || applied.version === undefined) return commandResult(scope, 'STEP_APPROVED', head.version, id);
        return commandResult(scope, 'ACCEPTED', applied.version, id);
      }
      // A return sends the report to its maker whatever the step: the report is decided and the instance ends with it.
      const returned = await applyReportDecision(this.reports, scope.tx, effects, { head, detail }, input, now, this.metrics);
      await this.flow.cancelIfRunning(scope.tx, effectsOf(scope), id, message('dis.workflow.cancel_reason.returned'), now);
      return commandResult(scope, returned.outcome, returned.version, id);
    }
    const done = await applyReportDecision(this.reports, scope.tx, effects, { head, detail }, input, now, this.metrics);
    return commandResult(scope, done.outcome, done.version, id);
  }

  @Post('reports/:id/corrections')
  @HttpCode(200)
  @OperationId('post_reports_id_corrections')
  @Command({ operation: 'post_reports_id_corrections', versioned: true })
  async correct(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['DisReportCorrection'],
  ): Promise<CommandResult> {
    const now = this.clock();
    const { amendmentReason } = correctionOf(body);
    const seen = projectScope(access, READ_PERMISSION, now);
    const head = await this.reports.lock(scope.tx, id, seen, projectScope(access, CORRECTION_PERMISSION, now), scope.expectedVersion ?? 0);
    const refusal = correctionSourceRefusal(head.status);
    if (refusal !== undefined) throw refusal;
    // A locked period takes no revision unless an approved reopening names the project.
    const judged = await this.periods.judge(scope.tx, head.periodId, head.projectId, now);
    const pending = await this.reports.pendingFor(scope.tx, head.projectId, head.periodId, id);
    if (pending !== undefined) throw new DomainError('REVISION_PENDING_EXISTS', 409, 'report_id', { extensions: { report_id: pending.id, revision: pending.revision, report_status: pending.status } });
    const latest = await this.reports.latestFor(scope.tx, head.projectId, head.periodId);
    if (latest !== undefined && latest.revision !== head.revision) throw new DomainError('REPORT_STATE_INVALID', 409, 'status', { extensions: { report_status: head.status, latest_revision: latest.revision } });
    const source = await this.reports.find(scope.tx, id, seen);
    if (source === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const effective = await this.reports.effectivePlan(scope.tx, head.projectId, judged.period.fiscalYear, judged.period.endDate);
    if (effective === undefined) throw new DomainError('PLAN_VERSION_NOT_EFFECTIVE', 422, 'plan_version_id');
    const carried = carriedOver(source, body);
    const attachments: AttachmentFile[] = source.attachments.map((file) => ({ fileObjectId: file.fileObjectId, fileSha256: file.fileSha256, fileName: file.fileName, contentType: file.contentType, sizeBytes: file.sizeBytes }));
    const input: NewCorrection = {
      projectId: head.projectId,
      periodId: head.periodId,
      planVersionId: effective.id,
      reportType: head.reportType,
      measurementBasis: head.measurementBasis,
      cells: carried.cells,
      negativeDeltaExplanation: carried.explanation,
      progress: carried.progress,
      narrative: source.narrative,
      attachments,
      asOfDate: judged.period.endDate,
      clientOperationId: undefined,
      allocations: await this.reports.allocations(scope.tx, effective.id),
      revision: (latest?.revision ?? head.revision) + 1,
      supersedesId: id,
      amendmentReason,
    };
    const made = await this.reports.createCorrection(scope.tx, input, scope.tenant.membershipId);
    const totals = fundingTotals(carried.cells);
    await scope.audit({
      action: 'dis.report_correction_started',
      resourceType: REPORT_RESOURCE,
      resourceId: made.id,
      diff: {
        project_code: source.project.code,
        period_code: source.period.code,
        revision: made.revision,
        supersedes_id: id,
        supersedes_status: head.status,
        plan_version_id: effective.id,
        cumulative_vnd: totals.cumulativeVnd,
        reopened: judged.reopen !== null,
      },
    });
    await scope.emit({
      aggregateType: REPORT_RESOURCE,
      aggregateId: made.id,
      aggregateVersion: made.version,
      type: 'report.correction_started.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
        report_id: made.id,
        supersedes_id: id,
        project_id: head.projectId,
        period_id: head.periodId,
        revision: made.revision,
        report_type: head.reportType,
      },
      eventKey: `${REPORT_RESOURCE}:${made.id}:correction_started`,
    });
    scope.afterCommit(() => this.metrics.increment(DIS_CORRECTION_METRIC, {}));
    return commandResult(scope, 'DRAFT', made.version, made.id);
  }
}
