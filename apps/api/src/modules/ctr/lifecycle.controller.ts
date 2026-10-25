import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { AuditWriter, BidContractorStore, CtrContractLifecycleStore, CtrContractSource, CtrContractStore, DoaMatrixStore, TenantDatabase, contractScope } from '@machvon/db';
import type { ActivationReadiness, CompletionReadiness, ContractDetail, ContractFacts, ContractScopes, LifecycleHooks, LifecycleResult } from '@machvon/db';
import { CONTRACT_DOA_DOCUMENT_TYPE, DomainError, contractTransition, isMakerOf, vietnamDateOf } from '@machvon/kernel';
import type { ContractCommand, EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { assertWithinDelegation } from '../../doa-delegation';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { CapitalCommitments } from '../cap/commitment.port';
import { placeRefs, reaches } from './contract.controller';
import { contractDetailView } from './contract-view';
import type { ContractRights } from './contract-view';
import { SummaryCache } from './summary-cache';

const SUBMIT_PERMISSION = PERMISSIONS.submitContractForReview;
const RETURN_PERMISSION = PERMISSIONS.returnContractDraft;
const SIGN_PERMISSION = PERMISSIONS.recordContractSigning;
const ACTIVATE_PERMISSION = PERMISSIONS.post_contracts_id_activate;
const CANCEL_PERMISSION = PERMISSIONS.cancelContractDraft;
const SUSPEND_PERMISSION = PERMISSIONS.suspendContract;
const TERMINATE_PERMISSION = PERMISSIONS.terminateContract;
const COMPLETE_PERMISSION = PERMISSIONS.completeContract;
const READ_PERMISSION = PERMISSIONS.get_resources_contract;
const SUMMARY_PERMISSION = PERMISSIONS.getContractSummary;
const LEDGER_PERMISSION = 'ledger.read';
const RESOURCE_TYPE = 'contract';
const CLASSIFICATION = 'INTERNAL';

const scopesFor = (access: EffectiveAccess, permission: string, now: Date): ContractScopes => ({ update: contractScope(access, permission, now), read: contractScope(access, READ_PERMISSION, now) });

/** The words the workspace shows the staff: what stands between the contract and its activation, and what the caller may do with it now. */
function readinessView(readiness: ActivationReadiness): Record<string, unknown> {
  return {
    boq: { total_vnd: readiness.boq.totalVnd, balanced: readiness.boq.balanced },
    guarantee: { required: readiness.guarantee.required, held: readiness.guarantee.held },
    permit_gate: { required: readiness.permitGate.required, status: readiness.permitGate.status, blocking: readiness.permitGate.blocking },
    capital: { allocation_line_id: readiness.capital.allocationLineId },
    project: { status: readiness.project.status, in_implementation: readiness.project.inImplementation },
  };
}

/**
 * What the caller may do with the contract as it stands: the command applies to its status, the caller holds the permission over it and is not one of the people whose work they would
 * approve. A button is shown for exactly these; the server judges each command again.
 */
export function actionsOf(detail: ContractDetail, access: EffectiveAccess, now: Date, caller: string): Record<string, boolean> {
  const refs = placeRefs(detail.reach);
  const maker = isMakerOf(caller, { createdBy: detail.createdBy, submittedBy: detail.submittedBy });
  const may = (command: ContractCommand, permission: string, checker: boolean): boolean => contractTransition(command, detail.status) !== undefined && reaches(access, permission, refs, now) && !(checker && maker);
  return {
    submit: may('submitContractForReview', SUBMIT_PERMISSION, false),
    return: may('returnContractDraft', RETURN_PERMISSION, true),
    sign: may('recordContractSigning', SIGN_PERMISSION, true),
    activate: may('activateContract', ACTIVATE_PERMISSION, true),
    cancel: may('cancelContractDraft', CANCEL_PERMISSION, false),
    suspend: may('suspendContract', SUSPEND_PERMISSION, false),
    resume: may('resumeContract', SUSPEND_PERMISSION, false),
    terminate: may('terminateContract', TERMINATE_PERMISSION, true),
    complete: may('completeContract', COMPLETE_PERMISSION, false),
  };
}

/** What stands between a contract that is being performed and its completion: the approved completion minutes it can rest on, the serious non-conformances still open and the measurements still to be decided. */
function completionView(completion: CompletionReadiness): Record<string, unknown> {
  return {
    acceptances: completion.acceptances.map((minutes) => ({ id: minutes.id, record_no: minutes.recordNo, approved_on: minutes.approvedOn })),
    open_critical_ncr_ids: completion.openCriticalNcrIds,
    pending_measurement_ids: completion.pendingMeasurementIds,
  };
}

/** The summary of a contract (CTR-03): the detail the other screens read, and for the staff the people behind the signature, what stands before the activation and what they may do now. */
export function summaryView(detail: ContractDetail, rights: ContractRights, staff: { readiness: ActivationReadiness | undefined; completion: CompletionReadiness | undefined; actions: Record<string, boolean> } | undefined): Record<string, unknown> {
  if (staff === undefined || !rights.internal) return contractDetailView(detail, rights);
  return {
    ...contractDetailView(detail, rights),
    submitted_by: detail.submittedBy,
    signed_by: detail.signedBy,
    signed_document_version_id: detail.signedDocumentVersionId,
    conflict_decision_ref: detail.conflictDecisionRef,
    activated_by: detail.activatedBy,
    ...(staff.readiness === undefined ? {} : { readiness: readinessView(staff.readiness) }),
    ...(staff.completion === undefined ? {} : { completion: completionView(staff.completion) }),
    actions: staff.actions,
  };
}

/**
 * The review, the signing and the activation of a contract (ST-CTR-004, CTR 3.1 steps 3 to 5, state machine of section 4). A command acts inside the scope of its own permission; the one
 * who drafted the contract or sent it to review never approves it (403 SELF_APPROVAL_DENIED); signing and activating are within the delegation limit the matrix of ADM gives the
 * value of the contract (403 SCOPE_DENIED above it); a person in conflict of interest with the contractor is blocked (409 CONFLICT_OF_INTEREST_BLOCKED, and the attempt is kept in the
 * audit trail even though the command rolls back). The activation commits the value of the contract against its line of capital in the same transaction. Status, tenant and signer have
 * no write path other than these commands.
 */
@Controller()
export class ContractLifecycleController {
  private readonly source = new CtrContractSource();
  private readonly contracts = new CtrContractStore(this.source);
  private readonly lifecycle = new CtrContractLifecycleStore({ source: this.source });
  private readonly contractors = new BidContractorStore();
  private readonly doa = new DoaMatrixStore();
  private readonly audit: AuditWriter;
  private readonly cache = new SummaryCache<ContractDetail>();

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Inject(CapitalCommitments) private readonly commitments: CapitalCommitments,
  ) {
    this.audit = new AuditWriter(database);
  }

  @Post('contracts/:id/submit-review')
  @HttpCode(200)
  @OperationId('submitContractForReview')
  @Command({ operation: 'submitContractForReview', versioned: true })
  async submit(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['CtrSubmitContractForReview']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.guarded(scope, 'submitContractForReview', id, () =>
      this.lifecycle.submit(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, body.note, scope.tenant.membershipId, scopesFor(access, SUBMIT_PERMISSION, now), vietnamDateOf(now)),
    );
    await this.written(scope, done, 'contract.review_requested', 'ctr.contract.review_requested.v1', now, {});
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('contracts/:id/return')
  @HttpCode(200)
  @OperationId('returnContractDraft')
  @Command({ operation: 'returnContractDraft', versioned: true })
  async giveBack(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['CtrReturnContractDraft']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.guarded(scope, 'returnContractDraft', id, () =>
      this.lifecycle.returnToDraft(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, body.reason, scope.tenant.membershipId, scopesFor(access, RETURN_PERMISSION, now), vietnamDateOf(now)),
    );
    await this.written(scope, done, 'contract.returned', 'ctr.contract.returned.v1', now, {}, done.reason);
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('contracts/:id/sign')
  @HttpCode(200)
  @OperationId('recordContractSigning')
  @Command({ operation: 'recordContractSigning', versioned: true })
  async sign(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['CtrRecordContractSigning']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.guarded(scope, 'recordContractSigning', id, () =>
      this.lifecycle.sign(
        scope.tx,
        id.toLowerCase(),
        scope.expectedVersion ?? 0,
        { signedOn: body.signed_on, signedDocumentVersionId: body.signed_document_version_id, conflictDecisionRef: body.conflict_decision_ref },
        scope.tenant.membershipId,
        scopesFor(access, SIGN_PERMISSION, now),
        vietnamDateOf(now),
        { authorise: this.delegation(scope, access, SIGN_PERMISSION, now) },
      ),
    );
    await this.written(scope, done, 'contract.signed', 'ctr.contract.signed.v1', now, {
      signed_on: done.signedOn,
      signed_document_version_id: done.signedDocumentVersionId,
      conflict_decision_ref: done.conflictDecisionRef,
    });
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('contracts/:id/activate')
  @HttpCode(200)
  @OperationId('post_contracts_id_activate')
  @Command({ operation: 'post_contracts_id_activate', versioned: true })
  async activate(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['CtrActivateContract']): Promise<CommandResult> {
    const now = new Date();
    // The body is the generic decision of the contract (approve, return, reject); the only decision a signed contract can take is the approval that activates it.
    if (body.decision !== 'approve') throw new DomainError('VALIDATION_FAILED', 422, 'decision');
    const hooks: LifecycleHooks = {
      authorise: this.delegation(scope, access, ACTIVATE_PERMISSION, now),
      commit: async (facts) => {
        // The activation is the approval of the use of the capital: a warning of the availability control is accepted by it, in its reason, and the audit row says so.
        const result = await this.commitments.checkAndCommit(scope, { allocationLineId: facts.allocationLineId, amountVnd: facts.contractValueVnd, sourceKind: 'CONTRACT', sourceId: facts.id, acknowledgeWarning: true }, now);
        return { entryId: result.entryId, replayed: result.replayed, warningAcknowledged: result.warningAcknowledged };
      },
    };
    const done = await this.guarded(scope, 'post_contracts_id_activate', id, () =>
      this.lifecycle.activate(
        scope.tx,
        id.toLowerCase(),
        scope.expectedVersion ?? 0,
        { effectiveFrom: body.effective_from, reason: body.reason, evidenceIds: body.evidence_ids },
        scope.tenant.membershipId,
        scopesFor(access, ACTIVATE_PERMISSION, now),
        vietnamDateOf(now),
        hooks,
      ),
    );
    await this.written(
      scope,
      done,
      'contract.activated',
      'ctr.contract.activated.v1',
      now,
      {
        effective_from: done.effectiveFrom,
        revision_id: done.revisionId,
        evidence_ids: done.evidenceIds,
        committed_vnd: done.committedVnd,
        allocation_line_id: done.allocationLineId,
        commitment_entry_id: done.commitment.entryId,
        warning_acknowledged: done.commitment.warningAcknowledged,
      },
      done.reason,
    );
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: done.id,
      aggregateVersion: done.version,
      type: 'ctr.commitment.changed.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        contract_id: done.id,
        project_id: done.projectId,
        allocation_line_id: done.allocationLineId,
        committed_vnd: done.committedVnd,
        version: done.version,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
      },
      eventKey: `${RESOURCE_TYPE}:${done.id}:commitment:${done.commitment.entryId}`,
    });
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('contracts/:id/suspend')
  @HttpCode(200)
  @OperationId('suspendContract')
  @Command({ operation: 'suspendContract', versioned: true })
  async suspend(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['CtrSuspendContract']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.guarded(scope, 'suspendContract', id, () =>
      this.lifecycle.suspend(
        scope.tx,
        id.toLowerCase(),
        scope.expectedVersion ?? 0,
        { reason: body.reason, decisionDocumentVersionId: body.decision_document_version_id, suspendedFrom: body.suspended_from },
        scope.tenant.membershipId,
        scopesFor(access, SUSPEND_PERMISSION, now),
        vietnamDateOf(now),
      ),
    );
    await this.written(scope, done, 'contract.suspended', 'ctr.contract.suspended.v1', now, { suspended_from: done.suspendedFrom, decision_document_version_id: done.decisionDocumentVersionId }, done.reason);
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('contracts/:id/resume')
  @HttpCode(200)
  @OperationId('resumeContract')
  @Command({ operation: 'resumeContract', versioned: true })
  async resume(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['CtrResumeContract']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.guarded(scope, 'resumeContract', id, () =>
      this.lifecycle.resume(
        scope.tx,
        id.toLowerCase(),
        scope.expectedVersion ?? 0,
        { reason: body.reason, decisionDocumentVersionId: body.decision_document_version_id, resumedOn: body.resumed_on, extensionDays: body.extension_days },
        scope.tenant.membershipId,
        scopesFor(access, SUSPEND_PERMISSION, now),
        vietnamDateOf(now),
      ),
    );
    await this.written(
      scope,
      done,
      'contract.resumed',
      'ctr.contract.resumed.v1',
      now,
      { resumed_on: done.resumedOn, extension_days_requested: done.extensionDays, decision_document_version_id: done.decisionDocumentVersionId },
      done.reason,
    );
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('contracts/:id/terminate')
  @HttpCode(200)
  @OperationId('terminateContract')
  @Command({ operation: 'terminateContract', versioned: true })
  async terminate(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['CtrTerminateContract']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.guarded(scope, 'terminateContract', id, () =>
      this.lifecycle.terminate(
        scope.tx,
        id.toLowerCase(),
        scope.expectedVersion ?? 0,
        { reason: body.reason, decisionDocumentVersionId: body.decision_document_version_id, terminatedOn: body.terminated_on, guaranteeAction: body.guarantee_action },
        scope.tenant.membershipId,
        scopesFor(access, TERMINATE_PERMISSION, now),
        vietnamDateOf(now),
        { authorise: this.delegation(scope, access, TERMINATE_PERMISSION, now) },
      ),
    );
    for (const move of done.guarantees) {
      await scope.audit({
        action: move.status === 'CALLED' ? 'guarantee.called' : 'guarantee.released',
        resourceType: 'guarantee',
        resourceId: move.id,
        classification: CLASSIFICATION,
        reason: done.reason,
        diff: { contract_id: move.contractId, kind: move.kind, amount_vnd: move.amountVnd, from_status: move.fromStatus, to_status: move.status, decision_document_version_id: done.decisionDocumentVersionId },
      });
    }
    await this.written(
      scope,
      done,
      'contract.terminated',
      'ctr.contract.terminated.v1',
      now,
      {
        terminated_on: done.terminatedOn,
        decision_document_version_id: done.decisionDocumentVersionId,
        guarantee_action: done.guaranteeAction,
        guarantees: done.guarantees.map((move) => ({ id: move.id, kind: move.kind, from_status: move.fromStatus, to_status: move.status })),
        violation_id: done.violationId,
        advance_outstanding_vnd: done.advanceOutstandingVnd,
      },
      done.reason,
    );
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('contracts/:id/complete')
  @HttpCode(200)
  @OperationId('completeContract')
  @Command({ operation: 'completeContract', versioned: true })
  async complete(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['CtrCompleteContract']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.guarded(scope, 'completeContract', id, () =>
      this.lifecycle.complete(
        scope.tx,
        id.toLowerCase(),
        scope.expectedVersion ?? 0,
        { completionQualityAcceptanceId: body.completion_quality_acceptance_id, completedOn: body.completed_on },
        scope.tenant.membershipId,
        scopesFor(access, COMPLETE_PERMISSION, now),
        vietnamDateOf(now),
      ),
    );
    await this.written(
      scope,
      done,
      'contract.completed',
      'ctr.contract.completed.v1',
      now,
      { completed_on: done.completedOn, completion_quality_acceptance_id: done.completionQualityAcceptanceId, completion_record_no: done.completionRecordNo },
      done.reason,
    );
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Get('contracts/:id/summary')
  @OperationId('getContractSummary')
  async summary(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = new Date();
    const view = await this.database.withTenant(tenant, async (tx) => {
      const scope = contractScope(access, READ_PERMISSION, now);
      const version = await this.lifecycle.versionIn(tx, id.toLowerCase(), scope);
      if (version === undefined) return undefined;
      // The detail is the same for every reader of the same version; what the reader may see of it, and what they may do with it, is judged on every read.
      const key = SummaryCache.keyOf(tenant.tenantId, id.toLowerCase(), version);
      let detail = this.cache.get(key);
      if (detail === undefined) {
        detail = await this.contracts.find(tx, id.toLowerCase(), scope);
        if (detail === undefined) return undefined;
        this.cache.set(key, detail);
      }
      const guest = (await this.contractors.callerOf(tx, tenant.membershipId)).guest;
      const rights: ContractRights = { internal: !guest, ledger: reaches(access, LEDGER_PERMISSION, placeRefs(detail.reach), now) };
      if (guest || !reaches(access, SUMMARY_PERMISSION, placeRefs(detail.reach), now)) return summaryView(detail, rights, undefined);
      return summaryView(detail, rights, {
        readiness: await this.lifecycle.readiness(tx, detail.id, vietnamDateOf(now)),
        completion: detail.status === 'ACTIVE' ? await this.lifecycle.completionReadiness(tx, detail.id) : undefined,
        actions: actionsOf(detail, access, now, tenant.membershipId),
      });
    });
    // A contract in another tenant or outside the scope of the caller is indistinguishable from one that does not exist.
    if (view === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return view;
  }

  /** The delegation limit of the matrix of ADM for the value of the contract, tested against the grants of the caller: 403 `SCOPE_DENIED` above it, 422 `DOA_RULE_NOT_FOUND` when no rule applies. */
  private delegation(scope: CommandScope, access: EffectiveAccess, permission: string, now: Date): LifecycleHooks['authorise'] {
    return (facts: ContractFacts): Promise<void> =>
      assertWithinDelegation(this.doa, scope, access, {
        documentType: CONTRACT_DOA_DOCUMENT_TYPE,
        permission,
        amountVnd: facts.contractValueVnd,
        unitId: facts.ownerUnit.id,
        place: { ownerUnitPath: facts.ownerUnit.path, ownerUnitId: facts.ownerUnit.id, projectId: facts.projectId, contractId: facts.id },
        now,
        unconfigured: 'REFUSE',
      });
  }

  /** Runs a command of the life of a contract; a refusal for a conflict of interest is kept in the audit trail in a transaction of its own, because the command rolls back. */
  private async guarded<T>(scope: CommandScope, command: string, id: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof DomainError && error.code === 'CONFLICT_OF_INTEREST_BLOCKED') {
        await this.audit.recordDenied(scope.tenant, {
          action: 'contract.conflict_blocked',
          resourceType: RESOURCE_TYPE,
          resourceId: id.toLowerCase(),
          classification: CLASSIFICATION,
          diff: { command, actor_id: scope.tenant.membershipId, ...error.extensions },
          correlationId: scope.correlationId,
          requestId: scope.requestId,
        });
      }
      throw error;
    }
  }

  /** The audit row and the event of a command that moved the contract: ids, statuses and the facts of the move, never the words of a signature beyond what the row names. */
  private async written(scope: CommandScope, done: LifecycleResult, action: string, type: string, now: Date, extra: Record<string, unknown>, reason?: string): Promise<void> {
    await scope.audit({
      action,
      resourceType: RESOURCE_TYPE,
      resourceId: done.id,
      classification: CLASSIFICATION,
      diff: { code: done.code, from_status: done.fromStatus, to_status: done.status, ...extra },
      ...(reason === undefined ? {} : { reason }),
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: done.id,
      aggregateVersion: done.version,
      type,
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        contract_id: done.id,
        project_id: done.projectId,
        package_id: done.packageId,
        contractor_id: done.contractorId,
        code: done.code,
        status: done.status,
        from_status: done.fromStatus,
        version: done.version,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
        ...extra,
      },
      eventKey: `${RESOURCE_TYPE}:${done.id}:${done.version}`,
    });
  }
}
