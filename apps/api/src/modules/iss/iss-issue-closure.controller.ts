import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { IssIssueClosure, issueScope } from '@machvon/db';
import type { IssueHeader, IssueScopes } from '@machvon/db';
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

/** Where the caller may act with the permission of a command, and where they may at least read (a miss is 404, a read without the right is 403). */
function scopesOf(access: EffectiveAccess, permission: string, now: Date): IssueScopes {
  return { act: issueScope(access, permission, now), read: issueScope(access, READ_PERMISSION, now) };
}

/**
 * The end of the life of an issue (ST-ISS-003, ISS 3.1 steps 4 to 7): the handler asks for a verification with evidence, a different person closes it,
 * a closed issue can be reopened within a window and the deadline can be extended a bounded number of times. Every command acts on an issue inside
 * the scope of its permission; the events carry ids, the state and the dates, never the notes.
 */
@Controller()
export class IssIssueClosureController {
  private readonly closure = new IssIssueClosure();

  @Post('issues/:id/request-verification')
  @HttpCode(200)
  @OperationId('requestIssueVerification')
  @Command({ operation: 'requestIssueVerification', versioned: true })
  async requestVerification(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['IssRequestIssueVerification'],
  ): Promise<CommandResult> {
    const now = new Date();
    const requested = await this.closure.requestVerification(
      scope.tx,
      id,
      scope.expectedVersion ?? 0,
      { resultNote: body.result_note, evidenceDocumentVersionIds: body.evidence_document_version_ids },
      scope.tenant.membershipId,
      scopesOf(access, PERMISSIONS.requestIssueVerification, now),
      now,
    );
    await this.record(scope, requested, 'iss.issue_verification_requested', 'iss.issue.verification_requested.v1', now, { evidence_count: requested.evidenceCount });
    return commandResult(scope, requested.status, requested.version, requested.id);
  }

  @Post('issues/:id/close')
  @HttpCode(200)
  @OperationId('closeIssue')
  @Command({ operation: 'closeIssue', versioned: true })
  async close(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['IssCloseIssue']): Promise<CommandResult> {
    const now = new Date();
    const closed = await this.closure.close(scope.tx, id, scope.expectedVersion ?? 0, { verificationNote: body.verification_note }, scope.tenant.membershipId, scopesOf(access, PERMISSIONS.closeIssue, now), now);
    await this.record(scope, closed, 'iss.issue_closed', 'iss.issue.closed.v1', now, { verifier_id: closed.verifierId, closed_at: closed.closedAt });
    return commandResult(scope, closed.status, closed.version, closed.id);
  }

  @Post('issues/:id/reopen')
  @HttpCode(200)
  @OperationId('reopenIssue')
  @Command({ operation: 'reopenIssue', versioned: true })
  async reopen(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['IssReopenIssue']): Promise<CommandResult> {
    const now = new Date();
    const reopened = await this.closure.reopen(scope.tx, id, scope.expectedVersion ?? 0, { reason: body.reason }, scope.tenant.membershipId, scopesOf(access, PERMISSIONS.reopenIssue, now), now);
    await this.record(scope, reopened, 'iss.issue_reopened', 'iss.issue.reopened.v1', now, { reopen_count: reopened.reopenCount, closed_at: reopened.closedAt });
    return commandResult(scope, reopened.status, reopened.version, reopened.id);
  }

  @Post('issues/:id/extend')
  @HttpCode(200)
  @OperationId('extendIssueDeadline')
  @Command({ operation: 'extendIssueDeadline', versioned: true })
  async extend(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['IssExtendIssueDeadline']): Promise<CommandResult> {
    const now = new Date();
    const extended = await this.closure.extend(
      scope.tx,
      id,
      scope.expectedVersion ?? 0,
      { newDueAt: body.new_due_at, reason: body.reason },
      scope.tenant.membershipId,
      scopesOf(access, PERMISSIONS.extendIssueDeadline, now),
      now,
    );
    await this.record(scope, extended, 'iss.issue_extended', 'iss.issue.extended.v1', now, {
      previous_due_at: extended.previousDueAt,
      extension_count: extended.extensionCount,
      overdue_since: extended.overdueSince,
    });
    return commandResult(scope, extended.status, extended.version, extended.id);
  }

  /** The audit row and the event of a command: the audit row says what moved, the event tells the others (HOME, BI, NOT) with the common member set of an issue. */
  private async record(scope: CommandScope, issue: IssueHeader, action: string, type: string, now: Date, extra: Record<string, unknown>): Promise<void> {
    await scope.audit({ action, resourceType: ISSUE_RESOURCE, resourceId: issue.id, diff: { code: issue.code, to_status: issue.status, due_at: issue.dueAt, ...extra } });
    await scope.emit({
      aggregateType: ISSUE_RESOURCE,
      aggregateId: issue.id,
      aggregateVersion: issue.version,
      type,
      schemaVersion: 1,
      payload: issueEventPayload(scope, issue, now, extra),
      eventKey: `${ISSUE_RESOURCE}:${issue.id}:${issue.version}`,
    });
  }
}
