import { Body, Controller, HttpCode, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { IntegrationInboxStore, WORKER_MEMBERSHIP_ID } from '@machvon/db';
import type { IntegrationInboxProcessor } from '@machvon/db';
import { DomainError } from '@machvon/kernel';
import type { EffectiveAccess } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { ADM_INBOX_PROCESSOR } from './tokens';
import { holdsOnWholeTenant } from './tenant-authority';

const OPERATE_PERMISSION = PERMISSIONS.replayInboxEvent;
const RESOURCE_TYPE = 'integration_event_inbox';

/** The inbox is shared by every inbound channel of the tenant, so only a grant on the whole tenant operates it. */
function assertHolds(access: EffectiveAccess): void {
  if (!holdsOnWholeTenant(access, OPERATE_PERMISSION)) throw new DomainError('SCOPE_DENIED', 403);
}

/**
 * Replay of a failed or dead inbound event (ST-ADM-018, ADM 3.13, BR-ADM-10). The event goes back to RECEIVED with a clean count of attempts and
 * is taken up at once, after the command has committed, by the adapter of its provider (the worker takes it up within a minute otherwise). The
 * payload is never edited and never shown. A second replay of an event that is no longer failed or dead is 409 INBOX_STATE_INVALID.
 */
@Controller('integration-inbox')
export class IntegrationInboxController {
  private readonly store = new IntegrationInboxStore();
  private readonly processor: IntegrationInboxProcessor;

  constructor(@Inject(ADM_INBOX_PROCESSOR) processor: IntegrationInboxProcessor) {
    this.processor = processor;
  }

  @Post(':inboxEventId/replay')
  @HttpCode(202)
  @OperationId('replayInboxEvent')
  @Command({ operation: 'replayInboxEvent', versioned: true })
  async replay(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('inboxEventId', ParseUUIDPipe) inboxEventId: string,
    @Body() body: Schemas['ReasonOnly'],
  ): Promise<CommandResult> {
    assertHolds(access);
    const { before, row } = await this.store.requeue(scope.tx, inboxEventId, scope.expectedVersion ?? 0, scope.tenant.membershipId);
    await scope.audit({
      action: 'integration.inbox_replayed',
      resourceType: RESOURCE_TYPE,
      resourceId: inboxEventId,
      reason: body.reason,
      classification: 'INTERNAL',
      diff: {
        provider: row.provider,
        event_type: row.eventType,
        status_before: before.status,
        attempts_before: before.attempts,
        error_code_before: before.errorCode,
        replay_count: row.replayCount,
      },
    });
    // The adapter takes the event up as the worker would, not as the person who asked: it runs after the commit, and its failure is the event's, not the command's.
    const tenant = { tenantId: scope.tenant.tenantId, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 };
    scope.afterCommit(async () => void (await this.processor.processOne(tenant, inboxEventId)));
    return commandResult(scope, row.status, row.version, inboxEventId);
  }
}
