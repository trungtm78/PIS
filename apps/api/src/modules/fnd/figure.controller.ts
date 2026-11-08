import { Body, Controller, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { FIGURE_RESOURCE, FndFigureStore, projectScope } from '@machvon/db';
import type { FigureProposal, FigureResult } from '@machvon/db';
import { fundingPackCodeOfEdition, resolveEdition } from '@machvon/kernel';
import type { EffectiveAccess } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { FUNDING_PACK_CODE } from './tokens';

const CLASSIFICATION = 'CONFIDENTIAL';

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

  constructor(@Optional() @Inject(FUNDING_PACK_CODE) packCode?: string) {
    this.packCode = packCodeOf(packCode);
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
    return commandResult(scope, done.status, done.version, done.batchId);
  }

  @Post('funding-figures/batches/:batch_id/acceptance')
  @HttpCode(200)
  @OperationId('acceptFundingFigures')
  @Command({ operation: 'acceptFundingFigures', versioned: true })
  async accept(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('batch_id', ParseUUIDPipe) batchId: string): Promise<CommandResult> {
    const now = new Date();
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
    return commandResult(scope, done.status, done.version, done.batchId);
  }

  /** The audit row and the event of a command: ids, codes, counts and statuses, never an amount and never the name of a person; the reason goes to the audit row only (ADM-11). */
  private async written(scope: CommandScope, done: FigureResult, action: string, type: string, now: Date, reason?: string): Promise<void> {
    const facts = { project_id: done.projectId, project_code: done.projectCode, class_code: done.classCode, tier_code: done.tierCode, measure: done.measure, figure_kind: done.kind, period_grain: done.grain, plan_year: done.planYear, figure_count: done.count, conversions: done.conversions };
    await scope.audit({
      action,
      resourceType: FIGURE_RESOURCE,
      resourceId: done.batchId,
      classification: CLASSIFICATION,
      ...(reason === undefined ? {} : { reason }),
      diff: { from_status: done.fromStatus, to_status: done.status, ...facts },
    });
    await scope.emit({
      aggregateType: FIGURE_RESOURCE,
      aggregateId: done.batchId,
      aggregateVersion: done.version,
      type,
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, batch_id: done.batchId, ...facts, status: done.status, from_status: done.fromStatus, version: done.version, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${FIGURE_RESOURCE}:${done.batchId}:${done.version}:${type}`,
    });
  }
}
