import { Controller, Get, Inject } from '@nestjs/common';
import { TenantDatabase, ThemeStore } from '@machvon/db';
import { DomainError } from '@machvon/kernel';
import type { TenantContext } from '@machvon/kernel';
import type { Schemas } from '../../contract-types';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { FileService } from '../files/file.service';
import { versionView } from './theme-view';

/**
 * The tenant side of the theme (ST-SAS-005): a member reads the published version of their own tenant, and its logo. It needs the tenant
 * database only, so it stays active where the control plane is not configured; the System Admin side is ThemeController.
 */
@Controller()
export class TenantThemeController {
  constructor(
    @Inject(ThemeStore) private readonly store: ThemeStore,
    @Inject(TenantDatabase) private readonly tenants: TenantDatabase,
    @Inject(FileService) private readonly files: FileService,
  ) {}

  /** getMyPublishedTheme: the published version of the caller's own tenant, for any member (`tenant.theme.read`). */
  @Get('me/tenant/theme')
  @OperationId('getMyPublishedTheme')
  async mine(@CurrentTenant() tenant: TenantContext): Promise<Schemas['TenantThemeVersion']> {
    const published = await this.tenants.withTenant(tenant, (tx) => this.store.currentVersion(tx, tenant.tenantId));
    if (published === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return versionView(published);
  }

  /**
   * getMyThemeLogo: the logo of the published version of the caller's own tenant, for any member (`tenant.theme.read`). The file is private
   * (there is no public address of it): the application reads it with the token of the session, as base64, and keys its cache by the hash.
   * Only the logo of the version in force, and only a file whose scan found it clean; anything else answers 404 like a tenant without a logo.
   */
  @Get('me/tenant/theme/logo')
  @OperationId('getMyThemeLogo')
  async logo(@CurrentTenant() tenant: TenantContext): Promise<Schemas['TenantThemeLogo']> {
    const asset = await this.tenants.withTenant(tenant, (tx) => this.store.publishedLogo(tx, tenant.tenantId));
    if (asset === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const { bytes } = await this.files.readStored(tenant, asset.storageKey);
    return { content_hash: asset.contentHash, mime: asset.mime as Schemas['TenantThemeLogo']['mime'], content_base64: Buffer.from(bytes).toString('base64') };
  }
}
