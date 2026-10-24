import { Controller, Get, Inject } from '@nestjs/common';
import { NotificationPreferenceStore, TenantDatabase } from '@machvon/db';
import type { LockedChannel, PreferenceItem, PreferenceSnapshot } from '@machvon/db';
import type { TenantContext } from '@machvon/kernel';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';

/** openapi.json PreferenceView: the preferences of the caller as NOT-03 shows them, with the channels that are locked and the version a save is made under. */
function viewOf(snapshot: PreferenceSnapshot, locked: readonly LockedChannel[]): Record<string, unknown> {
  return {
    version: snapshot.version,
    is_default: snapshot.isDefault,
    quiet_start: snapshot.quietHours?.start ?? null,
    quiet_end: snapshot.quietHours?.end ?? null,
    time_zone: snapshot.timeZone,
    items: snapshot.items.map((item: PreferenceItem) => ({ event_category: item.eventCategory, channel: item.channel, enabled: item.enabled, digest_mode: item.digestMode })),
    locked: locked.map((entry) => ({ event_category: entry.eventCategory, channel: entry.channel })),
  };
}

/** The preferences of the caller (NOT-03). Only the caller's own: there is no id to name another person's. */
@Controller('me/notification-preferences')
export class MyPreferencesReadController {
  private readonly preferences = new NotificationPreferenceStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  @OperationId('getMyNotificationPreferences')
  async get(@CurrentTenant() tenant: TenantContext): Promise<Record<string, unknown>> {
    return this.database.withTenant(tenant, async (tx) => viewOf(await this.preferences.read(tx, tenant.membershipId), await this.preferences.lockedChannels(tx)));
  }
}
