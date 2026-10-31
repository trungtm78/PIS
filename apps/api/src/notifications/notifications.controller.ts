import { Body, Controller, Get, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { NotificationStore, TenantDatabase } from '@machvon/db';
import type { NotificationRow } from '@machvon/db';
import { DomainError, asUuid } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../command.decorator';
import type { CommandScope } from '../command-scope';
import { commandResult } from '../command-result';
import type { CommandResult } from '../command-result';
import { CurrentAccess } from '../current-access.decorator';
import { OperationId } from '../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../pagination';
import { CurrentTenant } from '../tenant-context.decorator';
import { PermissionResourceAccess } from './resource-access-port';
import type { ResourceAccessPort, ResourceRef } from './resource-access-port';

/** Injection token of the port that decides whether a member may still see what a notification is about. */
export const RESOURCE_ACCESS_PORT = Symbol('RESOURCE_ACCESS_PORT');

/** The title key shown instead of any content when the member lost access to the resource (NOT-02). */
export const UNAVAILABLE_TITLE_KEY = 'notification.content.unavailable.title';

/** openapi.json NotificationPage item. Without access the title is the "unavailable" key and nothing else of the record is sent. */
interface NotificationView {
  id: string;
  title: string;
  priority: string;
  status: string;
  read_at?: string;
  ack_required: boolean;
  acknowledged_at?: string;
  resource_ref?: string;
}

/** Metadata of an instance for the operator (no payload, no content). */
interface NotificationMetadata {
  id: string;
  event_id: string;
  workflow_version_id: string;
  recipient_id: string;
  purpose: string;
  source_event_type: string;
  status: string;
  priority: string;
  ack_required: boolean;
  read_at: string | null;
  acknowledged_at: string | null;
  expires_at: string;
  created_at: string;
  version: number;
}

/**
 * The owner unit path an event carries is the one it saw when it was written; a unit can move afterwards, and an old
 * ancestor's grant must not keep revealing the record. The path is therefore taken from the unit as it is now: a
 * resource that names no unit has no path, and a unit that no longer exists is left without one (its unit scopes do not reach it).
 */
export function withCurrentOwnerPath(resource: ResourceRef, unitPaths: ReadonlyMap<string, string>): ResourceRef {
  const rest: ResourceRef = { ...resource };
  delete rest.ownerUnitPath;
  delete rest.investorUnitPath;
  const currentPath = (unitId: string | undefined): string | undefined => {
    const unit = unitId === undefined ? undefined : asUuid(unitId);
    return unit === undefined ? undefined : unitPaths.get(unit);
  };
  const owner = currentPath(rest.ownerUnitId);
  const investor = currentPath(rest.investorUnitId);
  return { ...rest, ...(owner === undefined ? {} : { ownerUnitPath: owner }), ...(investor === undefined ? {} : { investorUnitPath: investor }) };
}

function ownerUnitsOf(rows: readonly NotificationRow[]): string[] {
  return rows.flatMap((row) => [row.ref?.resource?.ownerUnitId, row.ref?.resource?.investorUnitId].flatMap((unit) => (unit === undefined ? [] : [unit])));
}

function titleKeyOf(eventType: string): string {
  return `notification.event.${eventType}.title`;
}

/**
 * Content is rebuilt on every read under the caller's current access (NOT 3.2): while the member may read the
 * resource the title is the key of the event type and the deep link is the opaque reference; once they cannot, the
 * title is the "unavailable" key and nothing about the record is disclosed.
 */
function viewOf(row: NotificationRow, access: EffectiveAccess, port: ResourceAccessPort, now: Date, unitPaths: ReadonlyMap<string, string>): NotificationView {
  const resource = row.ref?.resource === undefined ? undefined : withCurrentOwnerPath(row.ref.resource, unitPaths);
  const available = resource === undefined || port.canRead(access, resource, now);
  const view: NotificationView = {
    id: row.id,
    title: available ? titleKeyOf(row.sourceEventType) : UNAVAILABLE_TITLE_KEY,
    priority: row.priority,
    status: row.status,
    ack_required: row.ackRequired,
  };
  if (row.readAt !== null) view.read_at = row.readAt.toISOString();
  if (row.acknowledgedAt !== null) view.acknowledged_at = row.acknowledgedAt.toISOString();
  if (available && row.ref?.deepLink !== undefined) view.resource_ref = row.ref.deepLink;
  return view;
}

function metadataOf(row: NotificationRow): NotificationMetadata {
  return {
    id: row.id,
    event_id: row.eventId,
    workflow_version_id: row.workflowVersionId,
    recipient_id: row.recipientId,
    purpose: row.purpose,
    source_event_type: row.sourceEventType,
    status: row.status,
    priority: row.priority,
    ack_required: row.ackRequired,
    read_at: row.readAt?.toISOString() ?? null,
    acknowledged_at: row.acknowledgedAt?.toISOString() ?? null,
    expires_at: row.expiresAt.toISOString(),
    created_at: row.createdAt.toISOString(),
    version: row.version,
  };
}

function pageOf<T>(rows: NotificationRow[], limit: number, map: (row: NotificationRow) => T): { items: T[]; next_cursor: string | null } {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  const more = rows.length > limit && last !== undefined;
  return { items: items.map(map), next_cursor: more ? encodeCursor({ code: last.createdKey, id: last.id }) : null };
}

/**
 * The member's own notifications (NOT-01, NOT-02): list, read and acknowledge. A notification of another member
 * is indistinguishable from a missing one, and reading is not acknowledging (BR-NOT-05).
 */
@Controller()
export class NotificationsController {
  private readonly store = new NotificationStore();
  private readonly port: ResourceAccessPort;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Optional() @Inject(RESOURCE_ACCESS_PORT) port?: ResourceAccessPort,
  ) {
    this.port = port ?? new PermissionResourceAccess();
  }

  @Get('me/notifications')
  @OperationId('listMyNotifications')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: NotificationView[]; next_cursor: string | null }> {
    const request = parsePageRequest(limit, cursor);
    const { rows, unitPaths } = await this.database.withTenant(tenant, async (tx) => {
      const found = await this.store.listFor(tx, tenant.membershipId, { limit: request.limit + 1, after: request.after });
      return { rows: found, unitPaths: await this.store.currentUnitPaths(tx, ownerUnitsOf(found)) };
    });
    const now = new Date();
    return pageOf(rows, request.limit, (row) => viewOf(row, access, this.port, now, unitPaths));
  }

  @Post('notifications/:notificationId/read')
  @HttpCode(200)
  @OperationId('markNotificationRead')
  @Command({ operation: 'markNotificationRead' })
  async read(@Scope() scope: CommandScope, @Param('notificationId', ParseUUIDPipe) id: string, @Body() body: { opened_via?: unknown }): Promise<CommandResult> {
    const row = await this.store.markRead(scope.tx, scope.tenant.membershipId, id);
    await scope.audit({ action: 'notification.read', resourceType: 'notification', resourceId: id, diff: { status: row.status, opened_via: body.opened_via } });
    return commandResult(scope, 'READ', row.version, id);
  }

  @Post('notifications/:notificationId/acknowledge')
  @HttpCode(200)
  @OperationId('acknowledgeNotification')
  @Command({ operation: 'acknowledgeNotification' })
  async acknowledge(
    @Scope() scope: CommandScope,
    @Param('notificationId', ParseUUIDPipe) id: string,
    @Body() body: { comment?: unknown },
  ): Promise<CommandResult> {
    const row = await this.store.acknowledge(scope.tx, scope.tenant.membershipId, id);
    await scope.audit({ action: 'notification.acknowledge', resourceType: 'notification', resourceId: id, diff: { status: row.status } });
    await scope.emit({
      aggregateType: 'notification',
      aggregateId: id,
      aggregateVersion: row.version,
      type: 'not.notification.acknowledged.v1',
      schemaVersion: 1,
      payload: {
        notification_id: id,
        recipient_id: scope.tenant.membershipId,
        acknowledged_at: row.acknowledgedAt?.toISOString() ?? null,
        // The optional comment (at most 1000 characters, checked by the request schema) travels with the event, not in the audit row.
        ...(typeof body.comment === 'string' ? { comment: body.comment } : {}),
      },
      eventKey: `not.notification.acknowledged.v1:${id}`,
    });
    return commandResult(scope, 'ACKNOWLEDGED', row.version, id);
  }
}

/** Operator reads of the notification instances of the tenant (openapi.json get_resources_notification_instance*): metadata only. */
@Controller('resources/notification_instance')
export class NotificationInstancesController {
  private readonly store = new NotificationStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  @OperationId('get_resources_notification_instance')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: NotificationMetadata[]; next_cursor: string | null }> {
    const request = parsePageRequest(limit, cursor);
    const rows = await this.database.withTenant(tenant, (tx) => this.store.listAll(tx, { limit: request.limit + 1, after: request.after }));
    return pageOf(rows, request.limit, metadataOf);
  }

  @Get(':id')
  @OperationId('get_resources_notification_instance_id')
  async get(@CurrentTenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) id: string): Promise<NotificationMetadata> {
    const row = await this.database.withTenant(tenant, (tx) => this.store.findAny(tx, id));
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return metadataOf(row);
  }
}
