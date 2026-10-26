import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { LndLandSource, LndPlanPostingStore, LndPlanStore, TenantDatabase, householdScopeUnits } from '@machvon/db';
import type { PlanFeedbackLine, PlanTimers, TenantTx } from '@machvon/db';
import { DomainError, daysBetween, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { mayActOnPlan } from './plan.controller';
import { projectRefs, reaches } from './reach';

const WRITE_PERMISSION = PERMISSIONS.postCompensationPlan;
const APPROVE_PERMISSION = PERMISSIONS.approveCompensationPlan;
const READ_PERMISSION = PERMISSIONS.getCompensationPlanTimers;
const RESOURCE_TYPE = 'compensation_plan';
const FEEDBACK_TYPE = 'compensation_plan_feedback';
const CLASSIFICATION = 'INTERNAL';

/** An opinion as the screen reads it: an allowlist of what an opinion is; the words are read only inside the unit they came from. */
export function feedbackLineView(line: PlanFeedbackLine): Record<string, unknown> {
  return {
    id: line.id,
    plan_id: line.planId,
    household_id: line.householdId,
    household_code: line.householdCode,
    owner_unit_id: line.ownerUnitId,
    channel: line.channel,
    summary: line.summary,
    status: line.status,
    recorded_on: line.recordedOn,
    handled_on: line.handledOn,
    handling_note: line.handlingNote,
    version: line.version,
  };
}

/** The timers of a plan with what is left of each on the day asked about (negative once it has passed), and the opinions counted: numbers, never words. */
export function planTimersView(timers: PlanTimers, today: string): Record<string, unknown> {
  return {
    plan_id: timers.planId,
    project_id: timers.projectId,
    status: timers.status,
    posting_started_on: timers.postingStartedOn,
    posting_ends_on: timers.postingEndsOn,
    approved_on: timers.approvedOn,
    payment_due_on: timers.paymentDueOn,
    payment_remaining_days: timers.paymentDueOn === null ? null : daysBetween(today, timers.paymentDueOn),
    feedback_open: timers.openFeedback,
    feedback_handled: timers.handledFeedback,
    deadlines: timers.deadlines.map((deadline) => ({
      id: deadline.id,
      timer_code: deadline.timerCode,
      days_applied: deadline.daysApplied,
      started_on: deadline.startedOn,
      due_on: deadline.dueOn,
      satisfied_on: deadline.satisfiedOn,
      status: deadline.status,
      remaining_days: deadline.status === 'RUNNING' ? daysBetween(today, deadline.dueOn) : null,
      legal_basis: deadline.legalBasis,
      awaiting_confirmation: deadline.awaitingConfirmation,
      cxn: deadline.cxn,
    })),
  };
}

/**
 * The posting of a plan to the households and the approval that follows it (ST-LND-006, LND 3.1 steps 5-6, BR-LND-02, UAT-AC377). The right to post, to record and handle opinions and to close the posting is
 * `land.plan.write` over the project of the plan; the right to approve is `land.plan.approve` over it, and it is the only one that is refused to the person who drafted the plan. A plan the caller cannot see does not
 * exist for them. The opinions belong to the households' units: they are recorded and handled inside the units of the caller (a grant on a project reaches no household), and the trail and the events carry ids,
 * dates and counts, never the words of an opinion.
 */
@Controller()
export class CompensationPlanPostingController {
  private readonly source = new LndLandSource();
  private readonly plans = new LndPlanStore(this.source);
  private readonly posting = new LndPlanPostingStore();

  @Post('compensation-plans/:id/post')
  @HttpCode(200)
  @OperationId('postCompensationPlan')
  @Command({ operation: 'postCompensationPlan', versioned: true })
  async post(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['LndPostCompensationPlan'],
  ): Promise<CommandResult> {
    const now = new Date();
    await mayActOnPlan(scope.tx, this.plans, this.source, access, id, WRITE_PERMISSION, now);
    const done = await this.posting.post(
      scope.tx,
      { planId: id, expectedVersion: scope.expectedVersion ?? 0, postingStartedOn: body.posting_started_on, postingPlaceText: body.posting_place_text },
      scope.tenant.membershipId,
      vietnamDateOf(now),
    );
    await scope.audit({
      action: 'lnd.plan_posted',
      resourceType: RESOURCE_TYPE,
      resourceId: done.planId,
      classification: CLASSIFICATION,
      diff: {
        project_id: done.projectId,
        posting_started_on: done.postingStartedOn,
        posting_ends_on: done.postingEndsOn,
        days_applied: done.daysApplied,
        deadline_id: done.deadlineId,
        rule_version_id: done.ruleVersionId,
        rule_revision: done.ruleRevision,
        parcels_moved: done.parcelsMoved,
        households_moved: done.householdsMoved,
      },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: done.planId,
      aggregateVersion: done.version,
      type: 'lnd.plan.posted.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        plan_id: done.planId,
        project_id: done.projectId,
        deadline_id: done.deadlineId,
        posting_started_on: done.postingStartedOn,
        posting_ends_on: done.postingEndsOn,
        days_applied: done.daysApplied,
        rule_version_id: done.ruleVersionId,
        version: done.version,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
      },
      eventKey: `${RESOURCE_TYPE}:${done.planId}:${done.version}`,
    });
    return commandResult(scope, 'POSTING', done.version, done.planId);
  }

  @Post('compensation-plans/:id/feedback')
  @HttpCode(200)
  @OperationId('recordPlanFeedback')
  @Command({ operation: 'recordPlanFeedback' })
  async recordFeedback(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['LndRecordPlanFeedback'],
  ): Promise<CommandResult> {
    const now = new Date();
    await mayActOnPlan(scope.tx, this.plans, this.source, access, id, WRITE_PERMISSION, now);
    const units = await householdScopeUnits(scope.tx, access, WRITE_PERMISSION, now);
    const done = await this.posting.recordFeedback(
      scope.tx,
      { planId: id, householdId: body.household_id, summary: body.summary, channel: body.channel },
      scope.tenant.membershipId,
      vietnamDateOf(now),
      units,
    );
    await scope.audit({
      action: 'lnd.plan_feedback_recorded',
      resourceType: RESOURCE_TYPE,
      resourceId: done.planId,
      classification: 'PERSONAL',
      diff: { project_id: done.projectId, feedback_id: done.id, household_id: done.householdId, channel: done.channel },
    });
    await scope.emit({
      aggregateType: FEEDBACK_TYPE,
      aggregateId: done.id,
      aggregateVersion: 1,
      type: 'lnd.plan.feedback_recorded.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        plan_id: done.planId,
        project_id: done.projectId,
        feedback_id: done.id,
        channel: done.channel,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
      },
      eventKey: `${FEEDBACK_TYPE}:${done.id}:1`,
    });
    return commandResult(scope, 'OPEN', 1, done.id);
  }

  @Post('compensation-plans/:id/feedback/:feedback_id/handle')
  @HttpCode(200)
  @OperationId('handlePlanFeedback')
  @Command({ operation: 'handlePlanFeedback' })
  async handleFeedback(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('feedback_id', ParseUUIDPipe) feedbackId: string,
    @Body() body: Schemas['LndHandlePlanFeedback'],
  ): Promise<CommandResult> {
    const now = new Date();
    await mayActOnPlan(scope.tx, this.plans, this.source, access, id, WRITE_PERMISSION, now);
    const units = await householdScopeUnits(scope.tx, access, WRITE_PERMISSION, now);
    const done = await this.posting.handleFeedback(scope.tx, { planId: id, feedbackId, handlingNote: body.handling_note }, scope.tenant.membershipId, vietnamDateOf(now), units);
    await scope.audit({
      action: 'lnd.plan_feedback_handled',
      resourceType: RESOURCE_TYPE,
      resourceId: done.planId,
      classification: 'PERSONAL',
      diff: { project_id: done.projectId, feedback_id: done.id, handled_on: done.handledOn, open_remaining: done.openRemaining },
    });
    await scope.emit({
      aggregateType: FEEDBACK_TYPE,
      aggregateId: done.id,
      aggregateVersion: 2,
      type: 'lnd.plan.feedback_handled.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        plan_id: done.planId,
        project_id: done.projectId,
        feedback_id: done.id,
        open_remaining: done.openRemaining,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
      },
      eventKey: `${FEEDBACK_TYPE}:${done.id}:2`,
    });
    return commandResult(scope, 'HANDLED', 2, done.id);
  }

  @Post('compensation-plans/:id/close-posting')
  @HttpCode(200)
  @OperationId('closePlanPosting')
  @Command({ operation: 'closePlanPosting', versioned: true })
  async closePosting(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['LndClosePlanPosting'],
  ): Promise<CommandResult> {
    const now = new Date();
    await mayActOnPlan(scope.tx, this.plans, this.source, access, id, WRITE_PERMISSION, now);
    const done = await this.posting.closePosting(scope.tx, { planId: id, expectedVersion: scope.expectedVersion ?? 0, feedbackSummary: body.feedback_summary }, scope.tenant.membershipId, vietnamDateOf(now));
    await scope.audit({
      action: 'lnd.plan_posting_closed',
      resourceType: RESOURCE_TYPE,
      resourceId: done.planId,
      classification: CLASSIFICATION,
      diff: { project_id: done.projectId, closed_on: done.closedOn, posting_ends_on: done.postingEndsOn, feedback_open: done.openFeedback, feedback_handled: done.handledFeedback, deadline_id: done.deadlineId },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: done.planId,
      aggregateVersion: done.version,
      type: 'lnd.plan.posting_closed.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        plan_id: done.planId,
        project_id: done.projectId,
        closed_on: done.closedOn,
        feedback_open: done.openFeedback,
        feedback_handled: done.handledFeedback,
        version: done.version,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
      },
      eventKey: `${RESOURCE_TYPE}:${done.planId}:${done.version}`,
    });
    return commandResult(scope, 'POSTING_CLOSED', done.version, done.planId);
  }

  @Post('compensation-plans/:id/approve')
  @HttpCode(200)
  @OperationId('approveCompensationPlan')
  @Command({ operation: 'approveCompensationPlan', versioned: true })
  async approve(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['LndApproveCompensationPlan'],
  ): Promise<CommandResult> {
    const now = new Date();
    await mayActOnPlan(scope.tx, this.plans, this.source, access, id, APPROVE_PERMISSION, now);
    const done = await this.posting.approve(
      scope.tx,
      { planId: id, expectedVersion: scope.expectedVersion ?? 0, approvedOn: body.approved_on, decisionDocumentVersionId: body.decision_document_version_id },
      scope.tenant.membershipId,
      vietnamDateOf(now),
    );
    await scope.audit({
      action: 'lnd.plan_approved',
      resourceType: RESOURCE_TYPE,
      resourceId: done.planId,
      classification: CLASSIFICATION,
      diff: {
        project_id: done.projectId,
        approved_on: done.approvedOn,
        payment_due_on: done.paymentDueOn,
        payment_days: done.paymentDays,
        rule_version_id: done.ruleVersionId,
        decision_document_version_id: done.decisionDocumentVersionId,
        parcels_moved: done.parcelsMoved,
      },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: done.planId,
      aggregateVersion: done.version,
      type: 'lnd.plan.approved.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        plan_id: done.planId,
        project_id: done.projectId,
        approved_on: done.approvedOn,
        payment_due_on: done.paymentDueOn,
        decision_document_version_id: done.decisionDocumentVersionId,
        version: done.version,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
      },
      eventKey: `${RESOURCE_TYPE}:${done.planId}:${done.version}`,
    });
    return commandResult(scope, 'APPROVED', done.version, done.planId);
  }
}

/** The opinions on a plan and its timers (LND-06), inside the scope of the caller. */
@Controller()
export class CompensationPlanPostingReadsController {
  private readonly source = new LndLandSource();
  private readonly plans = new LndPlanStore(this.source);
  private readonly posting = new LndPlanPostingStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('compensation-plans/:id/feedback')
  @OperationId('listPlanFeedback')
  async feedback(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('status') status?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const now = new Date();
    const rows = await this.database.withTenant(tenant, async (tx) => {
      await this.mayRead(tx, access, id, now);
      return this.posting.feedback(tx, id, await householdScopeUnits(tx, access, READ_PERMISSION, now), typeof status === 'string' ? status : undefined);
    });
    return { items: rows.map(feedbackLineView), next_cursor: null, as_of: now.toISOString() };
  }

  @Get('compensation-plans/:id/timers')
  @OperationId('getCompensationPlanTimers')
  async timers(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = new Date();
    const timers = await this.database.withTenant(tenant, async (tx) => {
      await this.mayRead(tx, access, id, now);
      return this.posting.timersOf(tx, id);
    });
    return { ...planTimersView(timers, vietnamDateOf(now)), as_of: now.toISOString() };
  }

  /** A plan the caller cannot see is as if it did not exist. */
  private async mayRead(tx: TenantTx, access: EffectiveAccess, planId: string, now: Date): Promise<void> {
    const place = await this.plans.place(tx, planId);
    const project = place === undefined ? undefined : await this.source.projectRef(tx, place.projectId);
    if (place === undefined || project === undefined || !reaches(access, READ_PERMISSION, projectRefs(project), now)) throw new DomainError('RESOURCE_NOT_FOUND', 404);
  }
}
