import { Body, Controller, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { FndFigureStore, projectScope } from '@machvon/db';
import type { FigureProposal, FigureResult } from '@machvon/db';
import { DomainError, fundingPackCodeOfEdition, message, resolveEdition, stagedApprovalOf, versionConflict } from '@machvon/kernel';
import type { EffectiveAccess } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { ApprovalHoldService } from '../adm/approval-hold.service';
import { APPROVAL_FINAL_COMMANDS, effectsOf } from '../adm/approval.service';
import type { FinalCommandRegistry } from '../adm/approval.service';
import { StagedApprovalFlow } from '../adm/staged-approval.flow';
import { writeFigureTrail } from './figure-trail';
import { FUNDING_PACK_CODE } from './tokens';

/** The pack of the process: the one the edition names, unless a test hands another in. */
export const packCodeOf = (given: string | undefined): string => given ?? fundingPackCodeOfEdition(resolveEdition(process.env));

/**
 * The commands on the stored figures of the funding model (FND-1, docs/fnd-funding-model.md sections 7.3 and 8): prepare a batch (the phased plan, an estimate, an actual, a late adjustment), hand it in, take it back,
 * accept it or send it back. Every command is audited (ADM-11) and announced in the outbox with ids, codes and counts only, never an amount: the audit row of a command says which batch moved from which status to which,
 * and an acceptance that replaced an estimate with an actual says so in a row of its own. Maker is not checker: the person who prepared a batch does not accept or return it.
 */
@Controller()
export class FundingFigureController {
  private readonly store = new FndFigureStore();
  private readonly packCode: string;
  private readonly flow: StagedApprovalFlow;

  constructor(
    @Optional() @Inject(FUNDING_PACK_CODE) packCode?: string,
    @Optional() @Inject(APPROVAL_FINAL_COMMANDS) commands?: FinalCommandRegistry,
    @Optional() @Inject(ApprovalHoldService) holds?: ApprovalHoldService,
  ) {
    this.packCode = packCodeOf(packCode);
    this.flow = new StagedApprovalFlow(stagedApprovalOf('FND_FIGURE'), commands, holds);
  }

  @Post('funding-figures/batches')
  @HttpCode(200)
  @OperationId('proposeFundingFigures')
  @Command({ operation: 'proposeFundingFigures' })
  async propose(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['FundingFigureProposal']): Promise<CommandResult> {
    const now = new Date();
    const adjusts = body.adjusts_plan_year !== undefined && body.adjusts_period_ordinal !== undefined ? { planYear: body.adjusts_plan_year, ordinal: body.adjusts_period_ordinal } : undefined;
    const input: FigureProposal = {
      projectId: body.project_id,
      classCode: body.class_code,
      tierCode: body.tier_code,
      measure: body.measure,
      kind: body.figure_kind,
      grain: body.period_grain,
      planYear: body.plan_year,
      basis: body.basis,
      asOfDate: body.as_of_date,
      entries: body.entries.map((entry) => ({ ordinal: entry.period_ordinal, amountVnd: entry.amount_vnd })),
      explanation: body.explanation,
      decisionDocumentId: body.decision_document_id,
      adjusts,
      sourceReportRevisionId: body.source_report_revision_id,
    };
    const done = await this.store.propose(scope.tx, input, this.packCode, scope.tenant.membershipId, projectScope(access, PERMISSIONS.proposeFundingFigures, now), now);
    await this.written(scope, done, 'funding.figure_proposed', 'funding.figure_proposed.v1', now);
    return commandResult(scope, done.status, done.version, done.batchId);
  }

  @Post('funding-figures/batches/:batch_id/submission')
  @HttpCode(200)
  @OperationId('submitFundingFigures')
  @Command({ operation: 'submitFundingFigures', versioned: true })
  async submit(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('batch_id', ParseUUIDPipe) batchId: string): Promise<CommandResult> {
    const now = new Date();
    const done = await this.store.submit(scope.tx, batchId, scope.expectedVersion ?? 0, scope.tenant.membershipId, projectScope(access, PERMISSIONS.submitFundingFigures, now), now);
    await this.written(scope, done, 'funding.figure_submitted', 'funding.figure_submitted.v1', now);
    await this.startIfStaged(scope, done, now);
    return commandResult(scope, done.status, done.version, done.batchId);
  }

  @Post('funding-figures/batches/:batch_id/acceptance')
  @HttpCode(200)
  @OperationId('acceptFundingFigures')
  @Command({ operation: 'acceptFundingFigures', versioned: true })
  async accept(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('batch_id', ParseUUIDPipe) batchId: string): Promise<CommandResult> {
    const now = new Date();
    // A batch with a running instance (the tenant runs the staged approval) is accepted through the steps of the instance; one without is accepted as it always was.
    const instance = await this.flow.runningFor(scope.tx, batchId);
    if (instance !== undefined) return this.approveStep(scope, access, batchId, instance, now);
    const done = await this.store.accept(scope.tx, batchId, scope.expectedVersion ?? 0, scope.tenant.membershipId, this.packCode, projectScope(access, PERMISSIONS.acceptFundingFigures, now), now);
    await this.written(scope, done, 'funding.figure_accepted', 'funding.figure_accepted.v1', now);
    if (done.conversions > 0) await this.written(scope, done, 'funding.estimate_converted', 'funding.estimate_converted.v1', now);
    return commandResult(scope, done.status, done.version, done.batchId);
  }

  @Post('funding-figures/batches/:batch_id/return')
  @HttpCode(200)
  @OperationId('returnFundingFigures')
  @Command({ operation: 'returnFundingFigures', versioned: true })
  async sendBack(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('batch_id', ParseUUIDPipe) batchId: string, @Body() body: Schemas['FundingFigureReason']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.store.sendBack(scope.tx, batchId, scope.expectedVersion ?? 0, scope.tenant.membershipId, projectScope(access, PERMISSIONS.returnFundingFigures, now), now);
    await this.written(scope, done, 'funding.figure_returned', 'funding.figure_returned.v1', now, body.reason);
    // A return sends the batch to its preparer whatever the step: the batch is decided and the instance ends with it.
    await this.flow.cancelIfRunning(scope.tx, effectsOf(scope), batchId, message('fnd.workflow.default_return_reason'), now);
    return commandResult(scope, done.status, done.version, done.batchId);
  }

  @Post('funding-figures/batches/:batch_id/withdrawal')
  @HttpCode(200)
  @OperationId('withdrawFundingFigures')
  @Command({ operation: 'withdrawFundingFigures', versioned: true })
  async withdraw(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('batch_id', ParseUUIDPipe) batchId: string, @Body() body: Schemas['FundingFigureReason']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.store.withdraw(scope.tx, batchId, scope.expectedVersion ?? 0, scope.tenant.membershipId, projectScope(access, PERMISSIONS.withdrawFundingFigures, now), now);
    await this.written(scope, done, 'funding.figure_withdrawn', 'funding.figure_withdrawn.v1', now, body.reason);
    await this.flow.cancelIfRunning(scope.tx, effectsOf(scope), batchId, message('fnd.workflow.cancel_reason.withdrawn'), now);
    return commandResult(scope, done.status, done.version, done.batchId);
  }

  /** The audit row and the event of a command (see `writeFigureTrail`); the reason goes to the audit row only (ADM-11). */
  private written(scope: CommandScope, done: FigureResult, action: string, type: string, now: Date, reason?: string): Promise<void> {
    return writeFigureTrail({ actor: scope.tenant.membershipId, audit: (entry) => scope.audit(entry), emit: (event) => scope.emit(event) }, scope.tenant.tenantId, done, action, type, now, reason);
  }

  /** A tenant that approved the staged mode for figure batches has the hand-in start an instance: the acceptance then waits for the steps (QT.01). */
  private async startIfStaged(scope: CommandScope, done: FigureResult, now: Date): Promise<void> {
    if (!(await this.flow.isStaged(scope.tx, now))) return;
    const [project] = await scope.tx.query<{ owner_unit_id: string }>('select owner_unit_id from machvon.project where id = $1::uuid', [done.projectId]);
    if (project === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    await this.flow.startIfStaged(scope.tx, effectsOf(scope), { id: done.batchId, version: done.version, unitId: project.owner_unit_id, amountVnd: null, initiator: scope.tenant.membershipId }, now);
  }

  /** The acceptance of a batch that has a running instance: the decision of the task of the person who decides; the batch itself is accepted by the final command when the last step approves (or the receiver confirms the PUSH step). */
  private async approveStep(scope: CommandScope, access: EffectiveAccess, batchId: string, instance: Parameters<StagedApprovalFlow['approve']>[2], now: Date): Promise<CommandResult> {
    const seen = projectScope(access, PERMISSIONS.acceptFundingFigures, now);
    const current = await this.store.find(scope.tx, batchId, seen, true);
    if (current === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (current.version !== (scope.expectedVersion ?? 0)) throw versionConflict(current.version);
    const step = await this.flow.approve(scope.tx, effectsOf(scope), instance, { reason: undefined }, now, scope.tenant.tenantId);
    // The PUSH step handed its package over: the batch is accepted when the receiver confirms, not before (R22).
    if (step.step === 'HELD') return commandResult(scope, step.hold?.state === 'PUSH_FAILED' ? 'PUSH_FAILED' : 'AWAITING_RECEIPT', current.version, batchId);
    if (step.step !== 'COMPLETED') return commandResult(scope, 'STEP_APPROVED', current.version, batchId);
    const after = await this.store.find(scope.tx, batchId, seen);
    return commandResult(scope, after?.status ?? 'ACCEPTED', after?.version ?? current.version, batchId);
  }
}
