import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { NotificationWorkflowStore, TenantDatabase } from '@machvon/db';
import type { EventTypeEntry, NotificationWorkflowRecord } from '@machvon/db';
import { DomainError } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { holdsOnWholeTenant } from '../../modules/adm/tenant-authority';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { assertWorkflowDefinition } from '../workflow-definition';

const PUBLISH_PERMISSION = PERMISSIONS.post_notification_workflows_id_publish;
const WORKFLOW_RESOURCE = 'notification_workflow';
const STATUSES: readonly string[] = ['Draft', 'Published', 'Superseded', 'Retired'];

/** Who reads, writes and publishes the workflows of the tenant holds the permission on the whole tenant: a workflow decides who is told about an event of any unit. */
function assertHolds(access: EffectiveAccess): void {
  if (!holdsOnWholeTenant(access, PUBLISH_PERMISSION)) throw new DomainError('SCOPE_DENIED', 403);
}

function eventTypeView(entry: EventTypeEntry): Schemas['NotificationEventType'] {
  return {
    event_type: entry.eventType,
    owning_module: entry.owningModule,
    schema_version: entry.schemaVersion,
    allowed_purposes: entry.allowedPurposes,
    data_classification: entry.dataClassification,
    status: entry.status,
  };
}

function workflowView(row: NotificationWorkflowRecord): Schemas['NotificationWorkflow'] {
  return {
    id: row.id,
    event_type: row.eventType,
    revision: row.revision,
    status: row.status,
    definition: row.definition as Record<string, unknown>,
    created_by: row.createdBy,
    published_by: row.publishedBy,
    created_at: row.createdAt,
    published_at: row.publishedAt,
    supersedes_id: row.supersedesId,
    version: row.version,
  };
}

/**
 * The event types and the workflows of the notification center (ST-NOT-004, NOT-05 and NOT-06). The catalogue is the platform's: a tenant administrator reads it and writes a workflow per event type; another administrator
 * publishes it, and the notifications made afterwards follow it. The definition is judged against the entry of its event type when the draft is written and again when it is published, with the draft locked.
 */
@Controller()
export class NotificationWorkflowsController {
  private readonly store = new NotificationWorkflowStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('notification-event-types')
  @OperationId('listNotificationEventTypes')
  async eventTypes(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess): Promise<Schemas['NotificationEventTypePage']> {
    assertHolds(access);
    const entries = await this.database.withTenant(tenant, (tx) => this.store.eventTypes(tx));
    return { items: entries.map(eventTypeView) };
  }

  @Get('notification-workflows')
  @OperationId('listNotificationWorkflows')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('event_type') eventType?: unknown,
    @Query('status') status?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<Schemas['NotificationWorkflowPage']> {
    // The workflows of the tenant, with who wrote and who published them, are for who holds the permission on the whole tenant; a grant on one unit does not read them.
    assertHolds(access);
    const request = parsePageRequest(limit, cursor);
    if (status !== undefined && (typeof status !== 'string' || !STATUSES.includes(status))) throw new DomainError('VALIDATION_FAILED', 422, 'status');
    const filters = { eventType: typeof eventType === 'string' && eventType !== '' ? eventType : undefined, status: status as string | undefined };
    const rows = await this.database.withTenant(tenant, (tx) => this.store.list(tx, filters, { limit: request.limit + 1, after: request.after }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return { items: shown.map(workflowView), next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.sortKey, id: last.id }) : null };
  }

  @Post('notification-workflows')
  @HttpCode(201)
  @OperationId('createNotificationWorkflowDraft')
  @Command({ operation: 'createNotificationWorkflowDraft' })
  async create(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['NotificationWorkflowDraft']): Promise<CommandResult> {
    assertHolds(access);
    // The business type of a notification workflow is its event type; a client that names one says the same thing twice.
    if (body.business_type !== undefined && body.business_type !== body.event_type) throw new DomainError('VALIDATION_FAILED', 422, 'business_type');
    const entry = await this.store.activeEventType(scope.tx, body.event_type);
    if (entry === undefined) throw new DomainError('EVENT_TYPE_UNKNOWN', 422, 'event_type');
    assertWorkflowDefinition(body.definition, entry);
    const created = await this.store.createDraft(scope.tx, { eventType: entry.eventType, definition: body.definition }, scope.tenant.membershipId);
    await scope.audit({
      action: 'notification.workflow_created',
      resourceType: WORKFLOW_RESOURCE,
      resourceId: created.id,
      classification: 'INTERNAL',
      diff: { event_type: created.eventType, revision: created.revision },
    });
    return commandResult(scope, 'DRAFT', created.version, created.id);
  }

  @Post('notification-workflows/:id/publish')
  @HttpCode(200)
  @OperationId('post_notification_workflows_id_publish')
  @Command({ operation: 'post_notification_workflows_id_publish', versioned: true })
  async publish(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['Decision']): Promise<CommandResult> {
    assertHolds(access);
    // The Decision of the contract is shared by the approvals; publishing is a go-ahead, and a "return" or a "reject" has nothing to publish.
    if (body.decision !== 'approve') throw new DomainError('VALIDATION_FAILED', 422, 'decision');
    const done = await this.store.publish(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, scope.tenant.membershipId, new Date(), async (workflow) => {
      // An event type that was withdrawn since the draft was written takes its workflow with it.
      const entry = await this.store.activeEventType(scope.tx, workflow.eventType);
      if (entry === undefined) throw new DomainError('EVENT_TYPE_UNKNOWN', 422, 'event_type');
      assertWorkflowDefinition(workflow.definition, entry);
    });
    await scope.audit({
      action: 'notification.workflow_published',
      resourceType: WORKFLOW_RESOURCE,
      resourceId: done.workflow.id,
      reason: body.reason,
      classification: 'INTERNAL',
      diff: { event_type: done.workflow.eventType, revision: done.workflow.revision, superseded_id: done.supersededId },
    });
    await scope.emit({
      aggregateType: WORKFLOW_RESOURCE,
      aggregateId: done.workflow.id,
      aggregateVersion: done.workflow.version,
      type: 'not.workflow.published.v1',
      schemaVersion: 1,
      payload: { workflow_version_id: done.workflow.id, event_type: done.workflow.eventType, revision: done.workflow.revision, superseded_id: done.supersededId },
      eventKey: `${WORKFLOW_RESOURCE}:${done.workflow.id}:published`,
    });
    return commandResult(scope, 'PUBLISHED', done.workflow.version, done.workflow.id);
  }
}
