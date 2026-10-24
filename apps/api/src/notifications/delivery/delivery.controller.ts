import { Body, Controller, HttpCode, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import type { DeliveryEngine } from '@machvon/db';
import { DomainError } from '@machvon/kernel';
import type { EffectiveAccess } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { holdsOnWholeTenant } from '../../modules/adm/tenant-authority';
import { OperationId } from '../../operation-id.decorator';
import { DELIVERY_ENGINE } from './tokens';

const REPLAY_PERMISSION = PERMISSIONS.post_notifications_id_replay;
const CANCEL_PERMISSION = PERMISSIONS.cancelNotification;

/** The queue, the failed queue and the sends in flight belong to the whole tenant, not to one organisation unit, so only a grant on the whole tenant operates them. */
function assertHolds(access: EffectiveAccess, permission: string): void {
  if (!holdsOnWholeTenant(access, permission)) throw new DomainError('SCOPE_DENIED', 403);
}

/**
 * The operator commands on a notification that did not go out (ST-NOT-002, NOT 3.6): replay from the failed queue and cancel. Both are versioned on the
 * notification and audited with their reason. They change the queue only; the dispatcher makes the sends, later, with the checks of the moment of sending.
 */
@Controller('notifications')
export class NotificationDeliveryController {
  constructor(@Inject(DELIVERY_ENGINE) private readonly engine: DeliveryEngine) {}

  @Post(':id/replay')
  @HttpCode(202)
  @OperationId('post_notifications_id_replay')
  @Command({ operation: 'post_notifications_id_replay', versioned: true })
  async replay(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['Decision'],
  ): Promise<CommandResult> {
    assertHolds(access, REPLAY_PERMISSION);
    // The Decision of the contract is shared by the approvals; a replay is a go-ahead, and a "return" or a "reject" has nothing to replay.
    if (body.decision !== 'approve') throw new DomainError('VALIDATION_FAILED', 422, 'decision');
    const notificationId = id.toLowerCase();
    const result = await this.engine.replay(scope.tx, { notificationId, expectedVersion: scope.expectedVersion ?? 0, tenantId: scope.tenant.tenantId, now: new Date() });
    await scope.audit({
      action: 'notification.replayed',
      resourceType: 'notification',
      resourceId: notificationId,
      reason: body.reason,
      classification: 'INTERNAL',
      diff: { replay_notification_id: result.notificationId, started_new_chain: result.startedNewChain, channel: result.channel, evidence_count: body.evidence_ids.length },
    });
    return commandResult(scope, 'QUEUED', result.version, result.notificationId);
  }

  @Post(':notificationId/cancel')
  @HttpCode(200)
  @OperationId('cancelNotification')
  @Command({ operation: 'cancelNotification', versioned: true })
  async cancel(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('notificationId', ParseUUIDPipe) id: string,
    @Body() body: Schemas['ReasonOnly'],
  ): Promise<CommandResult> {
    assertHolds(access, CANCEL_PERMISSION);
    const notificationId = id.toLowerCase();
    const result = await this.engine.cancel(scope.tx, { notificationId, expectedVersion: scope.expectedVersion ?? 0, now: new Date() });
    // After a provider accepted the message only the request is recorded (NOT 3.6): the audit row says which of the two happened.
    await scope.audit({
      action: result.outcome === 'CANCELLED' ? 'notification.cancelled' : 'notification.cancel_requested',
      resourceType: 'notification',
      resourceId: notificationId,
      reason: body.reason,
      classification: 'INTERNAL',
      diff: { outcome: result.outcome, cancelled_attempts: result.cancelledAttempts },
    });
    return commandResult(scope, result.outcome, result.version, notificationId);
  }
}
