import { Body, Controller, HttpCode, Put } from '@nestjs/common';
import { NotificationPreferenceStore } from '@machvon/db';
import type { PreferenceItem } from '@machvon/db';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { OperationId } from '../../operation-id.decorator';

const PREFERENCE_RESOURCE = 'notification_preference';

/**
 * The choices of a person about how they are reached (ST-NOT-003, NOT-03, NOT 3.3): which channels they accept for which kind of event, a digest mode,
 * the hours in which they are not to be disturbed and the time zone those hours are in. The whole set is replaced under one version. The dispatcher reads it
 * again whenever it takes a send up, so a change counts for every message that has not gone out yet.
 */
@Controller('me/notification-preferences')
export class MyPreferencesController {
  private readonly preferences = new NotificationPreferenceStore();

  @Put()
  @HttpCode(200)
  @OperationId('updateMyNotificationPreferences')
  @Command({ operation: 'updateMyNotificationPreferences', versioned: true })
  async update(@Scope() scope: CommandScope, @Body() body: Schemas['PreferenceSet']): Promise<CommandResult> {
    const items: PreferenceItem[] = body.items.map((item) => ({
      eventCategory: item.event_category.trim(),
      channel: item.channel,
      enabled: item.enabled,
      digestMode: item.digest_mode ?? 'IMMEDIATE',
    }));
    const membershipId = scope.tenant.membershipId;
    const version = await this.preferences.replace(scope.tx, membershipId, { items, quietStart: body.quiet_start, quietEnd: body.quiet_end, timeZone: body.time_zone?.trim() }, scope.expectedVersion ?? 0);
    await scope.audit({
      action: 'notification.preferences_updated',
      resourceType: PREFERENCE_RESOURCE,
      resourceId: membershipId,
      classification: 'PERSONAL',
      diff: {
        items: items.length,
        channels_off: items.filter((item) => !item.enabled).length,
        quiet_hours: body.quiet_start === undefined ? 'OFF' : 'SET',
        time_zone: body.time_zone?.trim() ?? null,
      },
    });
    return commandResult(scope, 'Updated', version, membershipId);
  }
}
