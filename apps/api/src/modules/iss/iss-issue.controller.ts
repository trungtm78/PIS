import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { IssIssueStore, issueScope } from '@machvon/db';
import type { IssueHeader, IssuePlace, IssueScopes } from '@machvon/db';
import { DomainError, effectivePermissions, holdsPermission } from '@machvon/kernel';
import type { EffectiveAccess } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';

const ISSUE_RESOURCE = 'issue';
const CREATE_PERMISSION = PERMISSIONS.createIssue;
const ASSIGN_PERMISSION = PERMISSIONS.assignIssue;
const WORK_PERMISSION = PERMISSIONS.startIssue;
const READ_PERMISSION = PERMISSIONS.get_resources_issue_id;

/** The scopes of a command: where the caller holds its permission, and where they may at least read (a miss is 404, a read without the right is 403). */
function scopesOf(access: EffectiveAccess, permission: string, now: Date, reporter?: string): IssueScopes {
  const options = reporter === undefined ? {} : { reporter };
  return { act: issueScope(access, permission, now, options), read: issueScope(access, READ_PERMISSION, now, options) };
}

/** What every event of an issue carries to NOT, HOME and BI: ids, the state and the dates, never the text or the position (ISS 9). */
function eventPayload(scope: CommandScope, issue: IssueHeader, now: Date, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tenant_id: scope.tenant.tenantId,
    issue_id: issue.id,
    code: issue.code,
    project_id: issue.projectId,
    owner_unit_id: issue.ownerUnitId,
    severity: issue.severity,
    status: issue.status,
    assignee_id: issue.assigneeId,
    escalation_level: issue.escalationLevel,
    due_at: issue.dueAt,
    version: issue.version,
    actor_id: scope.tenant.membershipId,
    occurred_at: now.toISOString(),
    ...extra,
  };
}

/**
 * The lifecycle of an issue (ST-ISS-002, ISS 3.1 and 4): an issue is opened under the SLA policy in force, assigned, started, discussed and
 * moved to another unit. The status has no write path of its own and no generic one exists; every command acts on an issue inside the scope
 * of its permission, so an issue the caller cannot see does not exist for them. The events carry no text and no position.
 */
@Controller()
export class IssIssueController {
  private readonly issues = new IssIssueStore();

  @Post('issues')
  @HttpCode(200)
  @OperationId('createIssue')
  @Command({ operation: 'createIssue', ttl: 'extended' })
  async create(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['IssCreateIssue']): Promise<CommandResult> {
    const now = new Date();
    const authorize = (place: IssuePlace): void => {
      if (!holdsPermission(effectivePermissions(access, now, place), CREATE_PERMISSION)) throw new DomainError('SCOPE_DENIED', 403);
    };
    const created = await this.issues.create(
      scope.tx,
      {
        projectId: body.project_id,
        categoryVersionId: body.category_version_id,
        severity: body.severity,
        title: body.title,
        description: body.description,
        contractId: body.contract_id,
        ownerUnitId: body.owner_unit_id,
        sourceModule: body.source_module,
        sourceRefId: body.source_ref_id,
        geoConsent: body.geo_consent,
        geoLat: body.geo_lat,
        geoLng: body.geo_lng,
        geoAccuracyM: body.geo_accuracy_m,
        clientOperationId: body.client_operation_id,
      },
      scope.tenant.membershipId,
      now,
      authorize,
    );
    if (created.replayed) {
      // The phone sent the create again under another key: the issue is the one that exists, and nothing is written but the fact.
      await scope.audit({ action: 'iss.issue_open_replayed', resourceType: ISSUE_RESOURCE, resourceId: created.id, diff: { code: created.code, client_operation_id: body.client_operation_id.toLowerCase() } });
      return commandResult(scope, created.status, created.version, created.id);
    }
    // The audit row says that a position was stored, never where.
    await scope.audit({
      action: 'iss.issue_opened',
      resourceType: ISSUE_RESOURCE,
      resourceId: created.id,
      diff: {
        code: created.code,
        project_id: created.projectId,
        owner_unit_id: created.ownerUnitId,
        severity: created.severity,
        source_module: created.sourceModule,
        sla_policy_id: created.policyId,
        response_due_at: created.responseDueAt,
        due_at: created.dueAt,
        geo_recorded: created.geoRecorded,
      },
    });
    await scope.emit({
      aggregateType: ISSUE_RESOURCE,
      aggregateId: created.id,
      aggregateVersion: created.version,
      type: 'iss.issue.opened.v1',
      schemaVersion: 1,
      payload: eventPayload(scope, created, now, { response_due_at: created.responseDueAt, sla_policy_id: created.policyId, source_module: created.sourceModule }),
      eventKey: `${ISSUE_RESOURCE}:${created.id}:${created.version}`,
    });
    return commandResult(scope, created.status, created.version, created.id);
  }

  @Post('issues/:id/assign')
  @HttpCode(200)
  @OperationId('assignIssue')
  @Command({ operation: 'assignIssue', versioned: true })
  async assign(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['IssAssignIssue']): Promise<CommandResult> {
    const now = new Date();
    const assigned = await this.issues.assign(
      scope.tx,
      id,
      scope.expectedVersion ?? 0,
      { assigneeId: body.assignee_id, note: body.note },
      scope.tenant.membershipId,
      scopesOf(access, ASSIGN_PERMISSION, now),
      now,
    );
    await scope.audit({
      action: 'iss.issue_assigned',
      resourceType: ISSUE_RESOURCE,
      resourceId: assigned.id,
      diff: { code: assigned.code, from_status: assigned.previousStatus, to_status: assigned.status, from_assignee_id: assigned.previousAssigneeId, to_assignee_id: assigned.assigneeId },
    });
    await scope.emit({
      aggregateType: ISSUE_RESOURCE,
      aggregateId: assigned.id,
      aggregateVersion: assigned.version,
      type: 'iss.issue.assigned.v1',
      schemaVersion: 1,
      payload: eventPayload(scope, assigned, now, { previous_assignee_id: assigned.previousAssigneeId }),
      eventKey: `${ISSUE_RESOURCE}:${assigned.id}:${assigned.version}`,
    });
    return commandResult(scope, assigned.status, assigned.version, assigned.id);
  }

  @Post('issues/:id/start')
  @HttpCode(200)
  @OperationId('startIssue')
  @Command({ operation: 'startIssue', versioned: true })
  async start(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['IssStartIssue']): Promise<CommandResult> {
    const now = new Date();
    const started = await this.issues.start(scope.tx, id, scope.expectedVersion ?? 0, body.note, scope.tenant.membershipId, scopesOf(access, WORK_PERMISSION, now), now);
    await scope.audit({
      action: 'iss.issue_started',
      resourceType: ISSUE_RESOURCE,
      resourceId: started.id,
      diff: { code: started.code, from_status: 'ASSIGNED', to_status: started.status },
    });
    await scope.emit({
      aggregateType: ISSUE_RESOURCE,
      aggregateId: started.id,
      aggregateVersion: started.version,
      type: 'iss.issue.started.v1',
      schemaVersion: 1,
      payload: eventPayload(scope, started, now),
      eventKey: `${ISSUE_RESOURCE}:${started.id}:${started.version}`,
    });
    return commandResult(scope, started.status, started.version, started.id);
  }

  @Post('issues/:id/comments')
  @HttpCode(200)
  @OperationId('commentIssue')
  @Command({ operation: 'commentIssue' })
  async comment(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['IssCommentIssue']): Promise<CommandResult> {
    const now = new Date();
    // The person who reported the issue may comment on it wherever it lies, as long as their role lets them work issues.
    const commented = await this.issues.comment(scope.tx, id, { note: body.note, documentVersionId: body.document_version_id }, scope.tenant.membershipId, scopesOf(access, WORK_PERMISSION, now, scope.tenant.membershipId));
    await scope.audit({
      action: 'iss.issue_commented',
      resourceType: ISSUE_RESOURCE,
      resourceId: commented.id,
      diff: { code: commented.code, event_id: commented.eventId, document_attached: commented.attachedDocument },
    });
    await scope.emit({
      aggregateType: ISSUE_RESOURCE,
      aggregateId: commented.id,
      aggregateVersion: commented.version,
      type: 'iss.issue.commented.v1',
      schemaVersion: 1,
      payload: eventPayload(scope, commented, now, { event_id: commented.eventId, document_attached: commented.attachedDocument }),
      eventKey: `${ISSUE_RESOURCE}:${commented.id}:comment:${commented.eventId}`,
    });
    return commandResult(scope, commented.status, commented.version, commented.id);
  }

  @Post('issues/:id/transfer')
  @HttpCode(200)
  @OperationId('transferIssueUnit')
  @Command({ operation: 'transferIssueUnit', versioned: true })
  async transfer(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['IssTransferIssueUnit']): Promise<CommandResult> {
    const now = new Date();
    const moved = await this.issues.transfer(
      scope.tx,
      id,
      scope.expectedVersion ?? 0,
      { targetUnitId: body.target_unit_id, reason: body.reason },
      scope.tenant.membershipId,
      scopesOf(access, ASSIGN_PERMISSION, now),
      now,
    );
    await scope.audit({
      action: 'iss.issue_transferred',
      resourceType: ISSUE_RESOURCE,
      resourceId: moved.id,
      diff: { code: moved.code, from_unit_id: moved.fromUnitId, to_unit_id: moved.ownerUnitId, due_at: moved.dueAt },
    });
    await scope.emit({
      aggregateType: ISSUE_RESOURCE,
      aggregateId: moved.id,
      aggregateVersion: moved.version,
      type: 'iss.issue.transferred.v1',
      schemaVersion: 1,
      payload: eventPayload(scope, moved, now, { from_unit_id: moved.fromUnitId }),
      eventKey: `${ISSUE_RESOURCE}:${moved.id}:${moved.version}`,
    });
    return commandResult(scope, moved.status, moved.version, moved.id);
  }
}
