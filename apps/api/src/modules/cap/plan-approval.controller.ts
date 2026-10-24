import { Body, Controller, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import type { EffectiveAccess, MetricsSink } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CapitalPlanApprovalService } from './plan-approval.service';
import type { StepScope } from './plan-approval.service';
import { CAP_METRICS } from './tokens';

/** The step scope of a command: its transaction, the person who acts, and the audit trail and outbox of the command. */
function stepOf(scope: CommandScope): StepScope {
  return { tx: scope.tx, tenantId: scope.tenant.tenantId, actorId: scope.tenant.membershipId, audit: (entry) => scope.audit(entry), emit: (event) => scope.emit(event) };
}

/**
 * The approval and the publication of the capital plan (ST-CAP-003, CAP 3.1 F2 steps 3 to 5). The planner submits a DRAFT revision, an approver who
 * did not make it approves, returns or rejects it, and a publisher who did not make it publishes it with its decision document: the revision it
 * replaces is SUPERSEDED, the ledger and the balances move in the same transaction, and `capital.plan_published.v1` is written once for the project
 * register, which moves the funded projects of the pipeline to BUDGETED. The rules live in `CapitalPlanApprovalService`.
 */
@Controller()
export class CapitalPlanApprovalController {
  private readonly service: CapitalPlanApprovalService;

  constructor(@Optional() @Inject(CAP_METRICS) metrics?: MetricsSink) {
    this.service = new CapitalPlanApprovalService(metrics);
  }

  @Post('capital-plans/:id/submit')
  @HttpCode(200)
  @OperationId('submitCapitalPlan')
  @Command({ operation: 'submitCapitalPlan', versioned: true, ttl: 'extended' })
  async submit(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    const result = await this.service.submit(stepOf(scope), access, id, scope.expectedVersion ?? 0);
    return commandResult(scope, result.status, result.version, result.planId);
  }

  @Post('capital-plans/:id/decision')
  @HttpCode(200)
  @OperationId('decideCapitalPlan')
  @Command({ operation: 'decideCapitalPlan', versioned: true, ttl: 'extended' })
  async decide(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['MdmDecision'],
  ): Promise<CommandResult> {
    const result = await this.service.decide(stepOf(scope), access, id, scope.expectedVersion ?? 0, { decision: body.decision, reason: body.reason });
    return commandResult(scope, result.status, result.version, result.planId);
  }

  @Post('plans/:id/publish')
  @HttpCode(200)
  @OperationId('post_plans_id_publish')
  @Command({ operation: 'post_plans_id_publish', versioned: true, ttl: 'extended' })
  async publish(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['CapPublish']): Promise<CommandResult> {
    const result = await this.service.publish(stepOf(scope), access, id, scope.expectedVersion ?? 0, { decisionDocumentId: body.decision_document_id, effectiveAt: body.effective_at });
    return commandResult(scope, result.status, result.version, result.planId);
  }
}
