import { Body, Controller, Get, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { DocInteropStore, TenantDatabase } from '@machvon/db';
import type { InteropRecord } from '@machvon/db';
import { DomainError, INTEROP_DIRECTIONS, INTEROP_STATUSES } from '@machvon/kernel';
import type { EffectiveAccess, InteropDirection, InteropStatus, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { holdsOnWholeTenant } from '../adm/tenant-authority';
import { DocInteropService } from './interop.service';
import { DOC_CLOCK } from './tokens';

const RESOURCE_TYPE = 'doc_interop_message';

/** The message as the monitor reads it (an allowlist): never the envelope or the key it is kept under, which carry the letter itself. */
function messageView(record: InteropRecord): Record<string, unknown> {
  return {
    id: record.id,
    direction: record.direction,
    status: record.status,
    adapter_code: record.adapterCode,
    adapter_status: record.adapterStatus,
    external_message_id: record.externalMessageId,
    sender_code: record.senderCode,
    receiver_code: record.receiverCode,
    outgoing_document_id: record.outgoingDocumentId,
    incoming_document_id: record.incomingDocumentId,
    attempts: record.attempts,
    next_attempt_at: record.nextAttemptAt,
    error_code: record.errorCode,
    processed_at: record.processedAt,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    version: record.version,
    // A dead or failed message can be sent again by a person who may manage the messages.
    actions: { retry: record.direction === 'OUTBOUND' && (record.status === 'FAILED' || record.status === 'DEAD') },
  };
}

/**
 * Document interoperability through the LGSP (ST-DOC-021, DOC.md F13, DOC-20). The LGSP delivers a message to the webhook, which checks its signature, drops an envelope it has seen and makes the incoming letter; the
 * messages of the distributions on the LGSP channel leave through the job `doc-interop-send` with their waits and their end as DEAD, and a person who may manage them sends a failed or dead one again. The messages belong to the
 * tenant, not to a unit: every operation needs a grant on the whole tenant.
 */
@Controller()
export class DocInteropController {
  private readonly store = new DocInteropStore();
  private readonly clock: () => Date;

  constructor(
    @Inject(DocInteropService) private readonly service: DocInteropService,
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Optional() @Inject(DOC_CLOCK) clock?: () => Date,
  ) {
    this.clock = clock ?? ((): Date => new Date());
  }

  @Post('integrations/lgsp/inbound-messages')
  @HttpCode(200)
  @OperationId('receiveInteropMessage')
  @Command({ operation: 'receiveInteropMessage', ttl: 'extended' })
  async receive(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['DocInteropInbound']): Promise<CommandResult & Record<string, unknown>> {
    // The LGSP acts for the whole tenant through a service principal; a grant on a subtree does not make a caller the gateway.
    if (!holdsOnWholeTenant(access, PERMISSIONS.receiveInteropMessage)) throw new DomainError('SCOPE_DENIED', 403);
    const received = await this.service.receive(scope, body, this.clock());
    return { ...commandResult(scope, received.message.status, received.message.version, received.message.id), incoming_document_id: received.incomingDocumentId, document_id: received.documentId };
  }

  @Post('doc-interop-messages/:id/retry')
  @HttpCode(200)
  @OperationId('retryInteropMessage')
  @Command({ operation: 'retryInteropMessage', versioned: true })
  async retry(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    if (!holdsOnWholeTenant(access, PERMISSIONS.retryInteropMessage)) throw new DomainError('SCOPE_DENIED', 403);
    const { before, record } = await this.store.retry(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, scope.tenant.membershipId);
    // Ids, codes and the counts; never the envelope.
    await scope.audit({
      action: 'doc_interop_message.retry',
      resourceType: RESOURCE_TYPE,
      resourceId: record.id,
      classification: 'INTERNAL',
      diff: { from_status: before.status, to_status: record.status, attempts_before: before.attempts, error_code_before: before.errorCode, outgoing_document_id: record.outgoingDocumentId },
    });
    return commandResult(scope, record.status, record.version, record.id);
  }

  @Get('doc-interop-messages')
  @OperationId('listInteropMessages')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('status') status?: unknown,
    @Query('direction') direction?: unknown,
    @Query('cursor') cursor?: unknown,
    @Query('limit') limit?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    if (!holdsOnWholeTenant(access, PERMISSIONS.listInteropMessages)) throw new DomainError('SCOPE_DENIED', 403);
    const statusValue: InteropStatus | undefined = status === undefined ? undefined : INTEROP_STATUSES.find((candidate) => candidate === status);
    if (status !== undefined && statusValue === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'status');
    const directionValue: InteropDirection | undefined = direction === undefined ? undefined : INTEROP_DIRECTIONS.find((candidate) => candidate === direction);
    if (direction !== undefined && directionValue === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'direction');
    const page = parsePageRequest(limit, cursor);
    const found = await this.database.withTenant(tenant, (tx) => this.store.list(tx, { status: statusValue, direction: directionValue }, { limit: page.limit, after: page.after }));
    return { items: found.records.map(messageView), next_cursor: found.next === undefined ? null : encodeCursor(found.next), as_of: this.clock().toISOString() };
  }
}
