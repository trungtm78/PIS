import { Controller, HttpCode, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { DomainError } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import { OperationId } from '../../operation-id.decorator';
import { CHANNEL_ADAPTERS } from '../delivery/channel-adapters';
import type { ChannelAdapterRegistry } from '../delivery/channel-adapters';
import { PUSH_TOKEN_VAULT } from '../devices/push-vault';
import type { PushTokenVault } from '../devices/push-vault';
import { TenantRateLimiter } from './web-push-config';
import { WEB_PUSH_RUNTIME } from './web-push-wiring';
import type { WebPushRuntime } from './web-push-wiring';
import { isWebPushToken } from './web-push';

const DEVICE_RESOURCE = 'device_registration';
/** A person may test a device this often; a loop in a page cannot ring a phone all day. */
const TESTS_PER_MINUTE = 3;

/**
 * sendMyTestPush (YCK.01): the person presses "send a test notification to me" on the notification settings and the server sends one message to the device they name,
 * which must be their own and a web subscription. The message is the same as any web push (a generic title, which is the product name, and the start page): no record
 * stands behind it, so it carries no receipt and writes no notification. It is refused where the channel may not send (production before the live check), and the
 * answer says what the push service did, in words that do not name the device or its address.
 */
@Controller()
export class MyTestPushController {
  private readonly limiter = new TenantRateLimiter(TESTS_PER_MINUTE);

  constructor(
    @Inject(CHANNEL_ADAPTERS) private readonly adapters: ChannelAdapterRegistry,
    @Inject(PUSH_TOKEN_VAULT) private readonly vault: PushTokenVault,
    @Inject(WEB_PUSH_RUNTIME) private readonly web: WebPushRuntime,
  ) {}

  @Post('me/devices/:deviceId/test-push')
  @HttpCode(200)
  @OperationId('sendMyTestPush')
  @Command({ operation: 'sendMyTestPush' })
  async send(@Scope() scope: CommandScope, @Param('deviceId', ParseUUIDPipe) deviceId: string): Promise<CommandResult> {
    const id = deviceId.toLowerCase();
    const [device] = await scope.tx.query<{ push_secret_ref: string | null; platform: string }>(
      'select push_secret_ref, platform from machvon.device_registration where id = $1::uuid and membership_id = $2::uuid and revoked_at is null',
      [id, scope.tenant.membershipId],
    );
    if (device === undefined || device.platform !== 'web' || device.push_secret_ref === null) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (!this.limiter.take(`${scope.tenant.tenantId}:${id}`).ok) throw new DomainError('RATE_LIMIT', 429);
    const outcome = await this.outcomeOf(device.push_secret_ref, id, scope.tenant.tenantId);
    await scope.audit({ action: 'device.test_push_sent', resourceType: DEVICE_RESOURCE, resourceId: id, diff: { outcome } });
    return commandResult(scope, outcome, 1, id);
  }

  private async outcomeOf(secretRef: string, deviceId: string, tenantId: string): Promise<'SENT' | 'GONE' | 'RETRY_LATER' | 'CHANNEL_NOT_ACTIVE' | 'NO_TOKEN'> {
    if (this.adapters.usable('PUSH_FCM') === undefined) return 'CHANNEL_NOT_ACTIVE';
    let token: string | undefined;
    try {
      token = await this.vault.read(secretRef);
    } catch {
      return 'RETRY_LATER';
    }
    if (token === undefined || !isWebPushToken(token)) return 'NO_TOKEN';
    const answer = await this.web.provider.send({ token, data: { deep_link: '/m' }, silent: false, idempotencyKey: `test-push:${deviceId}:${Date.now()}`, tenantId, deviceId });
    if (answer.ok) return 'SENT';
    return answer.code === 'UNREGISTERED' || answer.code === 'INVALID_ARGUMENT_TOKEN' ? 'GONE' : 'RETRY_LATER';
  }
}
