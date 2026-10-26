import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { AudRecommendationStore, TenantDatabase, assertOwner, engagementScope, recommendationScope } from '@machvon/db';
import type { BoardLine } from '@machvon/db';
import { DomainError, asUuid, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { reaches } from '../lnd/reach';

const READ_PERMISSION = PERMISSIONS.listAuditEngagements;
const ASSIGN_PERMISSION = PERMISSIONS.assignAuditRecommendation;
const EXECUTE_PERMISSION = PERMISSIONS.planRemediationAction;
const VERIFY_PERMISSION = PERMISSIONS.verifyAuditRecommendation;
const RECOMMENDATION_TYPE = 'audit_recommendation';
const ACTION_TYPE = 'audit_remediation_action';
/** AUD data are CONFIDENTIAL (AUD 2): the trail and the events carry codes, ids, days and amounts, never what an owner, a verifier or an authority wrote in words. */
const CLASSIFICATION = 'CONFIDENTIAL';

/** A recommendation as AUD-04, AUD-06 and AUD-07 read it: an allowlist of what it is, who has it, when it is due and what has been done about it. */
export function recommendationView(line: BoardLine): Record<string, unknown> {
  return {
    id: line.id,
    conclusion_id: line.conclusionId,
    engagement: { id: line.engagement.id, engagement_code: line.engagement.code },
    finding_id: line.findingId,
    rec_code: line.recCode,
    rec_type: line.recType,
    description: line.description,
    amount_vnd: line.amountVnd,
    recovered_vnd: line.recoveredVnd,
    project_id: line.projectId,
    owner_unit_id: line.ownerUnit === null ? null : line.ownerUnit.id,
    owner_unit: line.ownerUnit === null ? null : { id: line.ownerUnit.id, code: line.ownerUnit.code, name: line.ownerUnit.name },
    owner_user: line.ownerUser === null ? null : { id: line.ownerUser.id, display_name: line.ownerUser.name },
    due_on: line.dueOn,
    implementation_due_on: line.implementationDueOn,
    status: line.status,
    is_overdue: line.isOverdue,
    linked_issue_id: line.linkedIssueId,
    dispute_reason: line.disputeReason,
    dispute_outcome: line.disputeOutcome,
    verification_note: line.verificationNote,
    submitted_by: line.submittedBy,
    disputed_by: line.disputedBy,
    actions: line.actions.map((action) => ({
      id: action.id,
      action_code: action.actionCode,
      description: action.description,
      planned_on: action.plannedOn,
      completed_on: action.completedOn,
      status: action.status,
      evidence_document_id: action.evidenceDocumentId,
      version: action.version,
    })),
    evidence_count: line.evidenceCount,
    created_at: line.createdAt,
    version: line.version,
  };
}

/** The optional uuid of a query: absent is undefined, one that is not a uuid is a field problem (422). */
function optionalUuid(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === 'string' ? asUuid(value) : undefined;
  if (parsed === undefined) throw new DomainError('VALIDATION_FAILED', 422, field);
  return parsed.toLowerCase();
}

/**
 * The commands that carry a recommendation to its end (ST-AUD-003, AUD 3.3 to 3.5): a leader assigns it to an owner with a day read from the conclusion; the owner plans actions, completes them
 * with evidence that is in force, reports the work for verification, or disputes the recommendation with an explanation; a verifier, who had no hand in the work, closes it or sends it back and
 * records the answer of the authority to a dispute. A caller finds a recommendation only through the scope of its engagement or because it was given to them (404 otherwise); who it was given to
 * does the work (422 NOT_OWNER for anyone else), and whoever did the work does not verify it (403 SELF_APPROVAL_DENIED). The trail and the events keep codes, ids, days and amounts.
 */
@Controller()
export class AuditRecommendationController {
  private readonly recommendations = new AudRecommendationStore();

  private seen(access: EffectiveAccess, now: Date) {
    return recommendationScope(access, READ_PERMISSION, EXECUTE_PERMISSION, now);
  }

  @Post('audit-recommendations/:id/assignment')
  @HttpCode(200)
  @OperationId('assignAuditRecommendation')
  @Command({ operation: 'assignAuditRecommendation', versioned: true })
  async assign(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['AudAssign'],
  ): Promise<CommandResult> {
    const now = new Date();
    const row = await this.recommendations.lock(scope.tx, id, this.seen(access, now), { acts: engagementScope(access, ASSIGN_PERMISSION, now) });
    this.recommendations.assertVersion(row, scope.expectedVersion ?? 0);
    this.recommendations.assertFollowedUp(row);
    // The linked issue of ISS is created by a later story (R2): asking for one now is refused rather than ignored.
    if (body.create_issue === true) throw new DomainError('VALIDATION_FAILED', 422, 'create_issue');
    // The unit must be in the tenant (404) and in the scope of the one who assigns (422): an owner outside it would be work nobody could follow.
    const unit = await this.recommendations.resolveUnit(scope.tx, body.owner_unit_id);
    if (!reaches(access, ASSIGN_PERMISSION, [{ ownerUnitPath: unit.path, ownerUnitId: unit.id }], now)) throw new DomainError('OWNER_OUT_OF_SCOPE', 422, 'owner_unit_id');
    const done = await this.recommendations.assign(scope.tx, row, { ownerUnitId: unit.id, ownerUserId: body.owner_user_id, dueOn: body.due_on, today: vietnamDateOf(now) }, scope.tenant.membershipId);
    const facts = { rec_code: row.recCode, conclusion_id: row.conclusionId, engagement_id: row.engagementId, owner_unit_id: unit.id, owner_user_id: body.owner_user_id ?? null, due_on: body.due_on };
    await scope.audit({
      action: 'aud.recommendation_assigned',
      resourceType: RECOMMENDATION_TYPE,
      resourceId: id,
      classification: CLASSIFICATION,
      diff: { ...facts, from_status: row.status, to_status: 'ASSIGNED' },
    });
    await scope.emit({
      aggregateType: RECOMMENDATION_TYPE,
      aggregateId: id,
      aggregateVersion: done.version,
      type: 'aud.recommendation.assigned.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, recommendation_id: id, ...facts, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${RECOMMENDATION_TYPE}:${id}:${done.version}`,
    });
    return commandResult(scope, 'ASSIGNED', done.version, id);
  }

  @Post('audit-recommendations/:id/actions')
  @HttpCode(200)
  @OperationId('planRemediationAction')
  @Command({ operation: 'planRemediationAction', versioned: true })
  async plan(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['AudActionPlan'],
  ): Promise<CommandResult> {
    const now = new Date();
    const row = await this.recommendations.lock(scope.tx, id, this.seen(access, now));
    assertOwner(row, access, EXECUTE_PERMISSION, now);
    this.recommendations.assertVersion(row, scope.expectedVersion ?? 0);
    this.recommendations.assertFollowedUp(row);
    const done = await this.recommendations.plan(scope.tx, row, { actionCode: body.action_code, description: body.description, plannedOn: body.planned_on }, scope.tenant.membershipId);
    const facts = { rec_code: row.recCode, engagement_id: row.engagementId, action_id: done.actionId, action_code: body.action_code.trim(), planned_on: body.planned_on };
    await scope.audit({
      action: 'aud.action_planned',
      resourceType: RECOMMENDATION_TYPE,
      resourceId: id,
      classification: CLASSIFICATION,
      diff: { ...facts, from_status: row.status, to_status: done.status },
    });
    await scope.emit({
      aggregateType: RECOMMENDATION_TYPE,
      aggregateId: id,
      aggregateVersion: done.version,
      type: 'aud.action.planned.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, recommendation_id: id, ...facts, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${RECOMMENDATION_TYPE}:${id}:${done.version}`,
    });
    return commandResult(scope, 'PLANNED', 1, done.actionId);
  }

  @Post('audit-remediation-actions/:id/completion')
  @HttpCode(200)
  @OperationId('completeRemediationAction')
  @Command({ operation: 'completeRemediationAction', versioned: true })
  async complete(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['AudActionComplete'],
  ): Promise<CommandResult> {
    const now = new Date();
    const action = await this.recommendations.lockAction(scope.tx, id, this.seen(access, now));
    assertOwner(action.recommendation, access, EXECUTE_PERMISSION, now);
    this.recommendations.assertVersion(action, scope.expectedVersion ?? 0);
    this.recommendations.assertFollowedUp(action.recommendation);
    const done = await this.recommendations.complete(scope.tx, action, { completedOn: body.completed_on, evidenceDocumentId: body.evidence_document_id, today: vietnamDateOf(now) }, scope.tenant.membershipId);
    const facts = {
      recommendation_id: action.recommendation.id,
      rec_code: action.recommendation.recCode,
      engagement_id: action.recommendation.engagementId,
      action_code: action.actionCode,
      completed_on: body.completed_on,
      evidence_document_id: body.evidence_document_id,
    };
    await scope.audit({ action: 'aud.action_completed', resourceType: ACTION_TYPE, resourceId: id, classification: CLASSIFICATION, diff: { ...facts, from_status: 'PLANNED', to_status: 'DONE' } });
    await scope.emit({
      aggregateType: ACTION_TYPE,
      aggregateId: id,
      aggregateVersion: done.version,
      type: 'aud.action.completed.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, action_id: id, ...facts, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${ACTION_TYPE}:${id}:${done.version}`,
    });
    return commandResult(scope, 'DONE', done.version, id);
  }

  @Post('audit-recommendations/:id/verification-request')
  @HttpCode(200)
  @OperationId('submitRecommendationForVerification')
  @Command({ operation: 'submitRecommendationForVerification', versioned: true })
  async submit(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    const now = new Date();
    const row = await this.recommendations.lock(scope.tx, id, this.seen(access, now));
    assertOwner(row, access, EXECUTE_PERMISSION, now);
    this.recommendations.assertVersion(row, scope.expectedVersion ?? 0);
    this.recommendations.assertFollowedUp(row);
    const done = await this.recommendations.submit(scope.tx, row, scope.tenant.membershipId);
    const facts = { rec_code: row.recCode, conclusion_id: row.conclusionId, engagement_id: row.engagementId, recovered_vnd: row.recoveredVnd };
    await scope.audit({
      action: 'aud.recommendation_submitted',
      resourceType: RECOMMENDATION_TYPE,
      resourceId: id,
      classification: CLASSIFICATION,
      diff: { ...facts, from_status: row.status, to_status: 'PENDING_VERIFICATION' },
    });
    await scope.emit({
      aggregateType: RECOMMENDATION_TYPE,
      aggregateId: id,
      aggregateVersion: done.version,
      type: 'aud.recommendation.submitted.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, recommendation_id: id, ...facts, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${RECOMMENDATION_TYPE}:${id}:${done.version}`,
    });
    return commandResult(scope, 'PENDING_VERIFICATION', done.version, id);
  }

  @Post('audit-recommendations/:id/verification')
  @HttpCode(200)
  @OperationId('verifyAuditRecommendation')
  @Command({ operation: 'verifyAuditRecommendation', versioned: true })
  async verify(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['AudVerification'],
  ): Promise<CommandResult> {
    const now = new Date();
    const row = await this.recommendations.lock(scope.tx, id, this.seen(access, now), { acts: engagementScope(access, VERIFY_PERMISSION, now) });
    this.recommendations.assertVersion(row, scope.expectedVersion ?? 0);
    this.recommendations.assertFollowedUp(row);
    const done = await this.recommendations.verify(scope.tx, row, { decision: body.decision, closureBasisDocumentId: body.closure_basis_document_id, comment: body.comment }, scope.tenant.membershipId);
    const closed = body.decision === 'CLOSE';
    const facts = { rec_code: row.recCode, conclusion_id: row.conclusionId, engagement_id: row.engagementId, decision: body.decision, closure_basis_document_id: body.closure_basis_document_id ?? null, recovered_vnd: row.recoveredVnd };
    await scope.audit({
      action: closed ? 'aud.recommendation_closed' : 'aud.recommendation_returned',
      resourceType: RECOMMENDATION_TYPE,
      resourceId: id,
      classification: CLASSIFICATION,
      diff: { ...facts, from_status: row.status, to_status: done.status, verified_by: closed ? scope.tenant.membershipId : null },
    });
    await scope.emit({
      aggregateType: RECOMMENDATION_TYPE,
      aggregateId: id,
      aggregateVersion: done.version,
      type: closed ? 'aud.recommendation.closed.v1' : 'aud.recommendation.returned.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, recommendation_id: id, ...facts, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${RECOMMENDATION_TYPE}:${id}:${done.version}`,
    });
    return commandResult(scope, done.status, done.version, id);
  }

  @Post('audit-recommendations/:id/dispute')
  @HttpCode(200)
  @OperationId('disputeAuditRecommendation')
  @Command({ operation: 'disputeAuditRecommendation', versioned: true })
  async dispute(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['AudDispute'],
  ): Promise<CommandResult> {
    const now = new Date();
    const row = await this.recommendations.lock(scope.tx, id, this.seen(access, now));
    assertOwner(row, access, EXECUTE_PERMISSION, now);
    this.recommendations.assertVersion(row, scope.expectedVersion ?? 0);
    this.recommendations.assertFollowedUp(row);
    const done = await this.recommendations.dispute(scope.tx, row, { reason: body.dispute_reason, documentId: body.dispute_document_id }, scope.tenant.membershipId);
    const facts = { rec_code: row.recCode, conclusion_id: row.conclusionId, engagement_id: row.engagementId, dispute_document_id: body.dispute_document_id };
    await scope.audit({
      action: 'aud.recommendation_disputed',
      resourceType: RECOMMENDATION_TYPE,
      resourceId: id,
      classification: CLASSIFICATION,
      diff: { ...facts, from_status: row.status, to_status: 'DISPUTED' },
    });
    await scope.emit({
      aggregateType: RECOMMENDATION_TYPE,
      aggregateId: id,
      aggregateVersion: done.version,
      type: 'aud.recommendation.disputed.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, recommendation_id: id, ...facts, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${RECOMMENDATION_TYPE}:${id}:${done.version}`,
    });
    return commandResult(scope, 'DISPUTED', done.version, id);
  }

  @Post('audit-recommendations/:id/dispute-decision')
  @HttpCode(200)
  @OperationId('recordAuditDisputeDecision')
  @Command({ operation: 'recordAuditDisputeDecision', versioned: true })
  async decide(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['AudDisputeDecision'],
  ): Promise<CommandResult> {
    const now = new Date();
    const row = await this.recommendations.lock(scope.tx, id, this.seen(access, now), { acts: engagementScope(access, VERIFY_PERMISSION, now) });
    this.recommendations.assertVersion(row, scope.expectedVersion ?? 0);
    this.recommendations.assertFollowedUp(row);
    const done = await this.recommendations.decide(scope.tx, row, { outcome: body.outcome, authorityDocumentId: body.authority_document_id }, scope.tenant.membershipId);
    const facts = { rec_code: row.recCode, conclusion_id: row.conclusionId, engagement_id: row.engagementId, outcome: body.outcome, authority_document_id: body.authority_document_id };
    await scope.audit({
      action: 'aud.recommendation_dispute_decided',
      resourceType: RECOMMENDATION_TYPE,
      resourceId: id,
      classification: CLASSIFICATION,
      diff: { ...facts, from_status: row.status, to_status: done.status },
    });
    await scope.emit({
      aggregateType: RECOMMENDATION_TYPE,
      aggregateId: id,
      aggregateVersion: done.version,
      type: 'aud.recommendation.dispute_decided.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, recommendation_id: id, ...facts, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${RECOMMENDATION_TYPE}:${id}:${done.version}`,
    });
    return commandResult(scope, done.status, done.version, id);
  }

  @Post('audit-evidence')
  @HttpCode(200)
  @OperationId('attachAuditEvidence')
  @Command({ operation: 'attachAuditEvidence' })
  async attach(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['AudEvidenceAttach']): Promise<CommandResult> {
    const now = new Date();
    const seen = { recommendations: this.seen(access, now), engagements: engagementScope(access, READ_PERMISSION, now) };
    // The object the evidence hangs on is found in the scope of the caller or not at all, whatever tenant it is in (404).
    const owner = await this.recommendations.locateEvidenceOwner(scope.tx, body.owner_kind, body.owner_id, seen);
    if (owner === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (owner.recommendationId !== null) {
      // The evidence of work is put by the one the work was given to.
      const row = await this.recommendations.lock(scope.tx, owner.recommendationId, seen.recommendations);
      assertOwner(row, access, EXECUTE_PERMISSION, now);
      this.recommendations.assertFollowedUp(row);
    } else if ((await this.recommendations.locateEvidenceOwner(scope.tx, body.owner_kind, body.owner_id, { ...seen, engagements: engagementScope(access, EXECUTE_PERMISSION, now) })) === undefined) {
      // The working documents of an engagement and of its findings are put by whoever may execute in its scope.
      throw new DomainError('SCOPE_DENIED', 403);
    }
    const attached = await this.recommendations.attachEvidence(scope.tx, { ownerKind: body.owner_kind, ownerId: body.owner_id, documentId: body.document_id, note: body.note }, scope.tenant.membershipId);
    await scope.audit({
      action: 'aud.evidence_attached',
      resourceType: 'audit_evidence',
      resourceId: attached.id,
      classification: CLASSIFICATION,
      diff: { owner_kind: body.owner_kind, owner_id: body.owner_id, document_id: body.document_id, engagement_id: owner.engagementId },
    });
    return commandResult(scope, 'ATTACHED', 1, attached.id);
  }
}

/** The recommendations the caller may see (AUD-04, AUD-06, AUD-07): through the scope of their engagement, or because they were given to the caller or to a unit that the caller executes for. */
@Controller()
export class AuditRecommendationReadsController {
  private readonly recommendations = new AudRecommendationStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('audit-recommendations')
  @OperationId('listAuditRecommendations')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('conclusion_id') conclusion?: unknown,
    @Query('engagement_id') engagement?: unknown,
    @Query('status') status?: unknown,
    @Query('owner_unit_id') ownerUnit?: unknown,
    @Query('overdue') overdue?: unknown,
    @Query('rec_type') recType?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null }> {
    const request = parsePageRequest(limit, cursor);
    if (overdue !== undefined && overdue !== 'true' && overdue !== 'false') throw new DomainError('VALIDATION_FAILED', 422, 'overdue');
    const rows = await this.database.withTenant(tenant, (tx) =>
      this.recommendations.list(tx, recommendationScope(access, READ_PERMISSION, EXECUTE_PERMISSION, new Date()), {
        limit: request.limit + 1,
        after: request.after,
        conclusionId: optionalUuid(conclusion, 'conclusion_id'),
        engagementId: optionalUuid(engagement, 'engagement_id'),
        status: typeof status === 'string' ? status : undefined,
        recType: typeof recType === 'string' ? recType : undefined,
        ownerUnitId: optionalUuid(ownerUnit, 'owner_unit_id'),
        overdue: overdue === undefined ? undefined : overdue === 'true',
      }),
    );
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return { items: shown.map(recommendationView), next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.recCode, id: last.id }) : null };
  }
}
