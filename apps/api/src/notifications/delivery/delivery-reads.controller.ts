import { Controller, Get, Inject, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { DeliveryStore, TenantDatabase } from '@machvon/db';
import type { AttemptFilter, AttemptHistoryRow, AttemptStatus, AttemptView } from '@machvon/db';
import { DomainError, asUuid } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { CurrentAccess } from '../../current-access.decorator';
import { holdsOnWholeTenant } from '../../modules/adm/tenant-authority';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';

const READ_PERMISSION = PERMISSIONS.get_resources_delivery_attempt;
const STATUSES: readonly AttemptStatus[] = ['Queued', 'Sending', 'ProviderAccepted', 'Delivered', 'Read', 'Failed', 'Unknown', 'Cancelled', 'Suppressed'];

type Page = { items: Array<Record<string, unknown>>; next_cursor: string | null };

/**
 * openapi.json delivery_attempt item (x-exposure dto): what the operator needs to follow a send and nothing that identifies the person or the message. There
 * is no address, no body, no payload and no recipient id in it; the provider message id is the provider's own reference, shown on NOT-12.
 */
export function attemptViewOf(view: AttemptView): Record<string, unknown> {
  return {
    id: view.id,
    notification_id: view.notificationId,
    notification_status: view.notificationStatus,
    notification_version: view.notificationVersion,
    expires_at: view.expiresAt,
    ack_required: view.ackRequired,
    acknowledged_at: view.acknowledgedAt,
    channel: view.channel,
    attempt_no: view.attemptNo,
    status: view.status,
    failure_class: view.failureClass,
    error_code: view.errorCode,
    provider_message_id: view.providerMessageId,
    queued_at: view.queuedAt,
    next_retry_at: view.nextRetryAt,
    sending_at: view.sendingAt,
    accepted_at: view.acceptedAt,
    delivered_at: view.deliveredAt,
    read_at: view.readAt,
    failed_at: view.failedAt,
    fallback_channel: view.fallbackChannel,
    needs_reconcile: view.needsReconcile,
    reconcile_due_at: view.reconcileDueAt,
    replay_of: view.replayOf,
  };
}

function historyViewOf(row: AttemptHistoryRow): Record<string, unknown> {
  return { from_status: row.fromStatus, to_status: row.toStatus, cause: row.cause, occurred_at: row.occurredAt };
}

function invalid(field: string): DomainError {
  return new DomainError('VALIDATION_FAILED', 422, field);
}

/** The optional filters of the list: `status` (one or several, comma separated), `notification_id`, `dlq=true`. A malformed one is 422, never ignored. */
function filterOf(status: unknown, notificationId: unknown, dlq: unknown): AttemptFilter {
  const filter: AttemptFilter = {};
  if (status !== undefined) {
    const names = typeof status === 'string' ? status.split(',') : [];
    if (names.length === 0 || names.some((name) => !(STATUSES as readonly string[]).includes(name))) throw invalid('status');
    filter.statuses = names as AttemptStatus[];
  }
  if (notificationId !== undefined) {
    const id = asUuid(notificationId);
    if (id === undefined) throw invalid('notification_id');
    filter.notificationId = id;
  }
  if (dlq !== undefined) {
    if (dlq !== 'true' && dlq !== 'false') throw invalid('dlq');
    filter.deadLetter = dlq === 'true';
  }
  return filter;
}

/**
 * Reads of the delivery attempts for the operator screens (ST-NOT-002, NOT-11 queue, NOT-12 journey, NOT-13 failed queue). The queue spans the people of
 * the whole tenant, so a grant on a subtree sees an empty list and a 404; the answer never carries an address, a body or a recipient.
 */
@Controller('resources/delivery_attempt')
export class DeliveryAttemptReadsController {
  private readonly store = new DeliveryStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  @OperationId('get_resources_delivery_attempt')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
    @Query('status') status?: unknown,
    @Query('notification_id') notificationId?: unknown,
    @Query('dlq') dlq?: unknown,
  ): Promise<Page> {
    const request = parsePageRequest(limit, cursor);
    const filter = filterOf(status, notificationId, dlq);
    if (!holdsOnWholeTenant(access, READ_PERMISSION)) return { items: [], next_cursor: null };
    const rows = await this.database.withTenant(tenant, (tx) => this.store.list(tx, filter, { limit: request.limit + 1, after: request.after }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return { items: shown.map(attemptViewOf), next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.cursorKey, id: last.id }) : null };
  }

  /** The attempt with the journey of its notification (every attempt, in order) and the changes of status of the attempt itself. */
  @Get(':id')
  @OperationId('get_resources_delivery_attempt_id')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    if (!holdsOnWholeTenant(access, READ_PERMISSION)) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const found = await this.database.withTenant(tenant, async (tx) => {
      const view = await this.store.find(tx, id.toLowerCase());
      if (view === undefined) return undefined;
      return { view, journey: await this.store.journey(tx, view.notificationId), history: await this.store.history(tx, view.id) };
    });
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { ...attemptViewOf(found.view), journey: found.journey.map(attemptViewOf), history: found.history.map(historyViewOf) };
  }
}
