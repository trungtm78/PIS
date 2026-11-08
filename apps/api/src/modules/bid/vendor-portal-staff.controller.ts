import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { VendorPortalStore, VendorRemediationStore } from '@machvon/db';
import { DomainError } from '@machvon/kernel';
import type { EffectiveAccess } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { holdsOnWholeTenant } from '../adm/tenant-authority';
import { PORTAL_CLASS, announcePortal } from './vendor-portal-view';

/**
 * The commands of the staff side of the contractor portal and of the plans of remediation (VND-20, VND-21; docs/vendor-investigation.md sections 5 and 7). Each runs in one transaction with its audit row and its outbox event
 * (ids and codes only; never the words of a request, an answer or a reason), is judged on a grant over the whole tenant (a register of contractors belongs to no unit), and leaves the time limits to the rules
 * `VENDOR_PORTAL` and `VENDOR_REMEDIATION`. The person who accepts an answer is never the person who gave it, and the person who verifies an action is never the person who marked it done.
 */
@Controller()
export class VendorPortalStaffController {
  private readonly requests = new VendorPortalStore();
  private readonly plans = new VendorRemediationStore();

  private require(access: EffectiveAccess, permission: string): void {
    if (!holdsOnWholeTenant(access, permission)) throw new DomainError('SCOPE_DENIED', 403);
  }

  private version(scope: CommandScope): number {
    return scope.expectedVersion ?? 0;
  }

  @Post('vendor/contractors/:id/portal-requests')
  @HttpCode(200)
  @OperationId('createVendorPortalRequest')
  @Command({ operation: 'createVendorPortalRequest' })
  async createRequest(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['VendorPortalRequestNew']): Promise<CommandResult> {
    this.require(access, PERMISSIONS.createVendorPortalRequest);
    const now = new Date();
    const row = await this.requests.create(scope.tx, id, { kind: body.kind, title: body.title, body: body.body, subjectType: body.subject_type, subjectId: body.subject_id, dueOn: body.due_on }, scope.tenant.membershipId, now);
    await announcePortal(scope, now, { action: 'vnd.portal_request_created', resourceType: 'contractor_portal_request', resourceId: row.id, classification: PORTAL_CLASS.plain, version: row.version, eventType: 'vnd.portal.request.changed.v1', diff: { contractor_id: id, kind: row.kind, due_at: row.dueAt, policy_version: row.deadlinePolicyVersion } });
    return commandResult(scope, 'CREATED', row.version, row.id);
  }

  @Post('vendor/portal-requests/:id/accept')
  @HttpCode(200)
  @OperationId('acceptVendorPortalRequest')
  @Command({ operation: 'acceptVendorPortalRequest', versioned: true })
  async accept(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    this.require(access, PERMISSIONS.acceptVendorPortalRequest);
    const now = new Date();
    const row = await this.requests.accept(scope.tx, id, this.version(scope), scope.tenant.membershipId, now);
    await announcePortal(scope, now, { action: 'vnd.portal_request_accepted', resourceType: 'contractor_portal_request', resourceId: id, classification: PORTAL_CLASS.answer, version: row.version, eventType: 'vnd.portal.request.changed.v1', diff: { contractor_id: row.contractorId, kind: row.kind, response_late: row.responseLate } });
    return commandResult(scope, 'ACCEPTED', row.version, id);
  }

  @Post('vendor/portal-requests/:id/return')
  @HttpCode(200)
  @OperationId('returnVendorPortalRequest')
  @Command({ operation: 'returnVendorPortalRequest', versioned: true })
  async returnRequest(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['VendorPortalReason']): Promise<CommandResult> {
    this.require(access, PERMISSIONS.returnVendorPortalRequest);
    const now = new Date();
    const row = await this.requests.returnRequest(scope.tx, id, this.version(scope), body.reason, scope.tenant.membershipId, now);
    await announcePortal(scope, now, { action: 'vnd.portal_request_returned', resourceType: 'contractor_portal_request', resourceId: id, classification: PORTAL_CLASS.answer, version: row.version, eventType: 'vnd.portal.request.changed.v1', reason: body.reason, diff: { contractor_id: row.contractorId, kind: row.kind, round: row.round } });
    return commandResult(scope, 'RETURNED', row.version, id);
  }

  @Post('vendor/portal-requests/:id/cancel')
  @HttpCode(200)
  @OperationId('cancelVendorPortalRequest')
  @Command({ operation: 'cancelVendorPortalRequest', versioned: true })
  async cancel(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['VendorPortalReason']): Promise<CommandResult> {
    this.require(access, PERMISSIONS.cancelVendorPortalRequest);
    const now = new Date();
    const row = await this.requests.cancel(scope.tx, id, this.version(scope), body.reason, scope.tenant.membershipId, now);
    await announcePortal(scope, now, { action: 'vnd.portal_request_cancelled', resourceType: 'contractor_portal_request', resourceId: id, classification: PORTAL_CLASS.plain, version: row.version, eventType: 'vnd.portal.request.changed.v1', reason: body.reason, diff: { contractor_id: row.contractorId, kind: row.kind } });
    return commandResult(scope, 'CANCELLED', row.version, id);
  }

  @Post('vendor/contractors/:id/remediation-plans')
  @HttpCode(200)
  @OperationId('createVendorRemediationPlan')
  @Command({ operation: 'createVendorRemediationPlan' })
  async createPlan(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['VendorRemediationPlanNew']): Promise<CommandResult> {
    this.require(access, PERMISSIONS.createVendorRemediationPlan);
    const now = new Date();
    const row = await this.plans.create(
      scope.tx,
      id,
      { title: body.title, objective: body.objective, contractId: body.contract_id, triggerKind: body.trigger_kind, triggerRef: body.trigger_ref, actions: body.actions.map((action) => ({ description: action.description, dueOn: action.due_on })) },
      scope.tenant.membershipId,
      now,
    );
    await announcePortal(scope, now, { action: 'vnd.remediation_plan_proposed', resourceType: 'contractor_remediation_plan', resourceId: row.id, classification: PORTAL_CLASS.plain, version: row.version, eventType: 'vnd.remediation.changed.v1', diff: { contractor_id: id, trigger_kind: row.triggerKind, actions: row.actionCount } });
    return commandResult(scope, 'CREATED', row.version, row.id);
  }

  @Post('vendor/remediation-plans/:id/start')
  @HttpCode(200)
  @OperationId('startVendorRemediationPlan')
  @Command({ operation: 'startVendorRemediationPlan', versioned: true })
  async start(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    this.require(access, PERMISSIONS.startVendorRemediationPlan);
    const now = new Date();
    const row = await this.plans.start(scope.tx, id, this.version(scope), scope.tenant.membershipId, now);
    await announcePortal(scope, now, { action: 'vnd.remediation_plan_started', resourceType: 'contractor_remediation_plan', resourceId: id, classification: PORTAL_CLASS.plain, version: row.version, eventType: 'vnd.remediation.changed.v1', diff: { contractor_id: row.contractorId } });
    return commandResult(scope, 'STARTED', row.version, id);
  }

  @Post('vendor/remediation-actions/:id/verification')
  @HttpCode(200)
  @OperationId('verifyVendorRemediationAction')
  @Command({ operation: 'verifyVendorRemediationAction', versioned: true })
  async verify(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['VendorRemediationVerify']): Promise<CommandResult> {
    this.require(access, PERMISSIONS.verifyVendorRemediationAction);
    const now = new Date();
    const row = await this.plans.verify(scope.tx, id, this.version(scope), body.outcome, body.note, scope.tenant.membershipId, now);
    await announcePortal(scope, now, { action: body.outcome === 'VERIFIED' ? 'vnd.remediation_action_verified' : 'vnd.remediation_action_reopened', resourceType: 'contractor_remediation_action', resourceId: id, classification: PORTAL_CLASS.plain, version: row.version, eventType: 'vnd.remediation.changed.v1', diff: { contractor_id: row.contractorId, plan_id: row.planId, outcome: body.outcome } });
    return commandResult(scope, body.outcome === 'VERIFIED' ? 'VERIFIED' : 'REOPENED', row.version, id);
  }

  @Post('vendor/remediation-plans/:id/completion')
  @HttpCode(200)
  @OperationId('completeVendorRemediationPlan')
  @Command({ operation: 'completeVendorRemediationPlan', versioned: true })
  async complete(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    this.require(access, PERMISSIONS.completeVendorRemediationPlan);
    const now = new Date();
    const row = await this.plans.complete(scope.tx, id, this.version(scope), scope.tenant.membershipId, now);
    await announcePortal(scope, now, { action: 'vnd.remediation_plan_completed', resourceType: 'contractor_remediation_plan', resourceId: id, classification: PORTAL_CLASS.plain, version: row.version, eventType: 'vnd.remediation.changed.v1', diff: { contractor_id: row.contractorId } });
    return commandResult(scope, 'COMPLETED', row.version, id);
  }

  @Post('vendor/remediation-plans/:id/closure')
  @HttpCode(200)
  @OperationId('closeVendorRemediationPlan')
  @Command({ operation: 'closeVendorRemediationPlan', versioned: true })
  async close(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['VendorRemediationClose']): Promise<CommandResult> {
    this.require(access, PERMISSIONS.closeVendorRemediationPlan);
    const now = new Date();
    const row = await this.plans.close(scope.tx, id, this.version(scope), body.outcome, body.reason, scope.tenant.membershipId, now);
    await announcePortal(scope, now, { action: body.outcome === 'FAILED' ? 'vnd.remediation_plan_failed' : 'vnd.remediation_plan_cancelled', resourceType: 'contractor_remediation_plan', resourceId: id, classification: PORTAL_CLASS.plain, version: row.version, eventType: 'vnd.remediation.changed.v1', reason: body.reason, diff: { contractor_id: row.contractorId, outcome: body.outcome } });
    return commandResult(scope, body.outcome, row.version, id);
  }
}
