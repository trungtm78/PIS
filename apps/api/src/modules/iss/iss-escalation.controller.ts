import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { ISSUE_ESCALATED_EVENT, IssEscalationStore, escalatedEventKey, escalatedPayload, issueScope } from '@machvon/db';
import type { IssueScopes } from '@machvon/db';
import type { EffectiveAccess } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { issueEventPayload } from './issue-event';

const ISSUE_RESOURCE = 'issue';
const READ_PERMISSION = PERMISSIONS.get_resources_issue_id;

/**
 * The escalation of an issue (ST-ISS-004, ISS 3.2): a coordinator raises it by hand to a unit or to the task force, and the receiver accepts it. The job
 * `issue-sla` raises it by itself with the same rules. An escalation never closes the issue. The events carry ids, the level and the dates, never the text.
 */
@Controller()
export class IssEscalationController {
  private readonly escalations = new IssEscalationStore();

  @Post('issues/:id/escalate')
  @HttpCode(200)
  @OperationId('escalateIssue')
  @Command({ operation: 'escalateIssue', versioned: true })
  async escalate(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['IssEscalateIssue']): Promise<CommandResult> {
    const now = new Date();
    const scopes: IssueScopes = { act: issueScope(access, PERMISSIONS.escalateIssue, now), read: issueScope(access, READ_PERMISSION, now) };
    const raised = await this.escalations.escalate(
      scope.tx,
      id,
      scope.expectedVersion ?? 0,
      { level: body.level, targetUnitId: body.target_unit_id, taskForceId: body.task_force_id, reason: body.reason },
      scope.tenant.membershipId,
      scopes,
      now,
    );
    // The audit row says what moved and to whom, never why in the words of the person.
    await scope.audit({
      action: 'iss.issue_escalated',
      resourceType: ISSUE_RESOURCE,
      resourceId: raised.id,
      diff: {
        code: raised.code,
        level: raised.level,
        trigger: raised.trigger,
        from_status: raised.previousStatus,
        to_status: raised.status,
        target_unit_id: raised.targetUnitId,
        task_force_id: raised.taskForceId,
        accept_due_at: raised.acceptDueAt,
      },
    });
    await scope.emit({
      aggregateType: ISSUE_RESOURCE,
      aggregateId: raised.id,
      aggregateVersion: raised.version,
      type: ISSUE_ESCALATED_EVENT,
      schemaVersion: 1,
      payload: escalatedPayload(scope.tenant.tenantId, raised, scope.tenant.membershipId, now),
      eventKey: escalatedEventKey(raised),
    });
    return commandResult(scope, raised.status, raised.version, raised.id);
  }

  @Post('issue-escalations/:id/accept')
  @HttpCode(200)
  @OperationId('acceptIssueEscalation')
  @Command({ operation: 'acceptIssueEscalation' })
  async accept(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['IssAcceptIssueEscalation']): Promise<CommandResult> {
    const now = new Date();
    const accepted = await this.escalations.accept(scope.tx, id, { note: body.note }, scope.tenant.membershipId, access, issueScope(access, READ_PERMISSION, now), now);
    await scope.audit({
      action: 'iss.issue_escalation_accepted',
      resourceType: ISSUE_RESOURCE,
      resourceId: accepted.id,
      diff: { code: accepted.code, escalation_id: accepted.escalationId, level: accepted.level, from_status: accepted.previousStatus, to_status: accepted.status },
    });
    await scope.emit({
      aggregateType: ISSUE_RESOURCE,
      aggregateId: accepted.id,
      aggregateVersion: accepted.version,
      type: 'iss.issue.escalation_accepted.v1',
      schemaVersion: 1,
      payload: issueEventPayload(scope, accepted, now, { escalation_id: accepted.escalationId, level: accepted.level }),
      eventKey: `${ISSUE_RESOURCE}:${accepted.id}:escalation:${accepted.escalationId}:accepted`,
    });
    // The resource of the answer is the escalation that was accepted; its status is the one the issue is in now.
    return commandResult(scope, accepted.status, accepted.version, accepted.escalationId);
  }
}
