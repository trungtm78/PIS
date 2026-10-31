import { Controller, Get, Inject } from '@nestjs/common';
import { ControlDatabase, FeatureFlagStore } from '@machvon/db';
import type { TenantContext } from '@machvon/kernel';
import { OperationId } from '../operation-id.decorator';
import { CurrentTenant } from '../tenant-context.decorator';

/**
 * The release flags that are on for the tenant of the session (ST-SAS-020, SAS-20). A flag only decides a code path while a release is staged: it never grants a right the entitlements do not give, so the client reads
 * it next to `getMyEntitlements` and uses it only to switch more off (BR-R07). The flags live in the control plane, so the tenant plane reads them through the control database.
 */
@Controller()
export class MyFeatureFlagsController {
  private readonly flags = new FeatureFlagStore();

  constructor(@Inject(ControlDatabase) private readonly control: ControlDatabase) {}

  @Get('me/feature-flags')
  @OperationId('getMyFeatureFlags')
  async mine(@CurrentTenant() tenant: TenantContext): Promise<{ items: Array<{ flag_key: string; enabled: boolean }> }> {
    const flags = await this.control.withControl((tx) => this.flags.enabledFor(tx, tenant.tenantId));
    return { items: flags.map((flag) => ({ flag_key: flag.key, enabled: flag.enabled })) };
  }
}
