import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { VendorPortalStore, VendorReconfirmationStore, VendorRemediationStore } from '@machvon/db';
import type { EffectiveAccess } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { PORTAL_CLASS, announcePortal, assertHoldsAnywhere } from './vendor-portal-view';

/**
 * The commands of the contractor portal (VND-16 to VND-19; docs/vendor-investigation.md section 5). The contractor is the one the guest membership of the caller is bound to (`VendorPortalStore.enter`), never a value of the
 * path or the body; the database holds the same boundary (V2446), so a request, a plan or an action of another contractor is 404. Each command runs in one transaction with its audit row (the answers are CONFIDENTIAL) and its
 * outbox event, which carries ids and codes only and never the words of an answer.
 */
@Controller()
export class PortalController {
  private readonly portal = new VendorPortalStore();
  private readonly reconfirmations = new VendorReconfirmationStore();
  private readonly plans = new VendorRemediationStore();

  private version(scope: CommandScope): number {
    return scope.expectedVersion ?? 0;
  }

  @Post('portal/requests/:id/response')
  @HttpCode(200)
  @OperationId('respondPortalRequest')
  @Command({ operation: 'respondPortalRequest', versioned: true })
  async respond(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PortalRespondRequest']): Promise<CommandResult> {
    assertHoldsAnywhere(access, PERMISSIONS.respondPortalRequest);
    const now = new Date();
    const caller = await this.portal.enter(scope.tx, scope.tenant.membershipId, { kind: 'REQUEST', id });
    const row = await this.portal.respond(scope.tx, caller, id, this.version(scope), { text: body.text, documentId: body.document_id, qualificationId: body.qualification_id }, now);
    await announcePortal(scope, now, { action: 'vnd.portal_request_answered', resourceType: 'contractor_portal_request', resourceId: id, classification: PORTAL_CLASS.answer, version: row.version, eventType: 'vnd.portal.request.changed.v1', diff: { contractor_id: caller.contractorId, kind: row.kind, round: row.round, response_late: row.responseLate } });
    return commandResult(scope, 'RESPONDED', row.version, id);
  }

  @Post('portal/qualifications')
  @HttpCode(200)
  @OperationId('submitPortalQualification')
  @Command({ operation: 'submitPortalQualification' })
  async submitQualification(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['PortalQualificationNew']): Promise<CommandResult> {
    assertHoldsAnywhere(access, PERMISSIONS.submitPortalQualification);
    const now = new Date();
    const caller = await this.portal.enter(scope.tx, scope.tenant.membershipId);
    const row = await this.portal.submitQualification(
      scope.tx,
      caller,
      { kind: body.kind, certificateNo: body.certificate_no, grade: body.grade, scope: body.scope, issuer: body.issuer, issuedOn: body.issued_on, expiresOn: body.expires_on, documentId: body.document_id },
      body.request_id,
      now,
    );
    await announcePortal(scope, now, { action: 'vnd.portal_qualification_submitted', resourceType: 'contractor_qualification', resourceId: row.id, classification: PORTAL_CLASS.plain, version: row.version, eventType: 'vnd.qualification.changed.v1', diff: { contractor_id: caller.contractorId, kind: row.kind, via: 'PORTAL' } });
    return commandResult(scope, 'CREATED', row.version, row.id);
  }

  @Post('portal/reconfirmation')
  @HttpCode(200)
  @OperationId('confirmPortalReconfirmation')
  @Command({ operation: 'confirmPortalReconfirmation' })
  async reconfirm(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['PortalReconfirmRequest']): Promise<CommandResult> {
    assertHoldsAnywhere(access, PERMISSIONS.confirmPortalReconfirmation);
    const now = new Date();
    const caller = await this.portal.enter(scope.tx, scope.tenant.membershipId);
    const done = await this.reconfirmations.confirm(scope.tx, caller, { declarationVersion: body.declaration_version, accepted: body.accepted, changesNote: body.changes_note }, now);
    await announcePortal(scope, now, { action: 'vnd.reconfirmation_recorded', resourceType: 'contractor_reconfirmation', resourceId: done.id, classification: PORTAL_CLASS.answer, version: 1, eventType: 'vnd.reconfirmation.recorded.v1', diff: { contractor_id: caller.contractorId, next_due_on: done.nextDueOn, declaration_version: done.declarationVersion } });
    return commandResult(scope, 'CONFIRMED', 1, done.id);
  }

  @Post('portal/remediation-plans/:id/agreement')
  @HttpCode(200)
  @OperationId('agreePortalRemediationPlan')
  @Command({ operation: 'agreePortalRemediationPlan', versioned: true })
  async agree(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    assertHoldsAnywhere(access, PERMISSIONS.agreePortalRemediationPlan);
    const now = new Date();
    const caller = await this.portal.enter(scope.tx, scope.tenant.membershipId, { kind: 'REMEDIATION_PLAN', id });
    const row = await this.plans.agree(scope.tx, caller, id, this.version(scope), now);
    await announcePortal(scope, now, { action: 'vnd.remediation_plan_agreed', resourceType: 'contractor_remediation_plan', resourceId: id, classification: PORTAL_CLASS.answer, version: row.version, eventType: 'vnd.remediation.changed.v1', diff: { contractor_id: caller.contractorId } });
    return commandResult(scope, 'AGREED', row.version, id);
  }

  @Post('portal/remediation-actions/:id/done')
  @HttpCode(200)
  @OperationId('markPortalRemediationActionDone')
  @Command({ operation: 'markPortalRemediationActionDone', versioned: true })
  async done(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PortalActionDone']): Promise<CommandResult> {
    assertHoldsAnywhere(access, PERMISSIONS.markPortalRemediationActionDone);
    const now = new Date();
    const caller = await this.portal.enter(scope.tx, scope.tenant.membershipId, { kind: 'REMEDIATION_ACTION', id });
    const row = await this.plans.markDone(scope.tx, caller, id, this.version(scope), { note: body.note, documentId: body.document_id }, now);
    await announcePortal(scope, now, { action: 'vnd.remediation_action_done', resourceType: 'contractor_remediation_action', resourceId: id, classification: PORTAL_CLASS.answer, version: row.version, eventType: 'vnd.remediation.changed.v1', diff: { contractor_id: caller.contractorId, plan_id: row.planId } });
    return commandResult(scope, 'DONE', row.version, id);
  }
}
