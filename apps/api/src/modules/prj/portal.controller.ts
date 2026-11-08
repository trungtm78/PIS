import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { PortalStore, TenantDatabase } from '@machvon/db';
import type { PortalRecordRow, PortalSettingRow } from '@machvon/db';
import { DomainError, OC4IDS_LISTS_STATUS, OC4IDS_PROJECT_REQUIRED, OC4IDS_VERSION, PORTAL_FIELDS } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { assertWholeTenant, booleanQuery, pageOf, todayOf } from '../gov12-support';

const SETTING = 'portal_setting';
const RECORD = 'portal_record';

const settingView = (row: PortalSettingRow | undefined): Record<string, unknown> | null =>
  row === undefined
    ? null
    : {
        slug: row.slug,
        enabled: row.enabled,
        whistle_enabled: row.whistleEnabled,
        title: row.title,
        publisher_name: row.publisherName,
        id_prefix: row.idPrefix,
        license_uri: row.licenseUri,
        policy_uri: row.policyUri,
        // The policy as it was when the settings were saved: the public side shows only these fields and applies this rate and this page size.
        allowed_fields: row.allowedFields,
        rate_per_minute: row.ratePerMinute,
        page_size_max: row.pageSizeMax,
        policy_rule_version: row.policyRuleVersion,
        whistle: { acknowledge_days: row.whistleAcknowledgeDays, resolve_days: row.whistleResolveDays, rate_per_hour: row.whistleRatePerHour, rule_version: row.whistleRuleVersion },
        updated_at: row.updatedAt,
        version: row.version,
      };

const recordView = (row: PortalRecordRow): Record<string, unknown> => ({ project_id: row.projectId, public_code: row.publicCode, fields: row.fields, fields_sha256: row.fieldsSha256, revision: row.revision, published_at: row.publishedAt, withdrawn_at: row.withdrawnAt, withdrawn_reason: row.withdrawnReason, version: row.version });

/**
 * The public portal (G4-9), publisher side. The publisher writes the settings (the address, the words, the policy copied from the rule in force) and publishes projects; a record is cut to the allow-list when it is
 * published, and the public surface reads only those cuts (see `portal-public.controller.ts`). Whole tenant only.
 */
@Controller()
export class PortalController {
  private readonly store = new PortalStore();

  @Post('portal/settings')
  @HttpCode(200)
  @OperationId('savePortalSettings')
  @Command({ operation: 'savePortalSettings' })
  async save(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['SavePortalSettings']): Promise<CommandResult> {
    assertWholeTenant(access, PERMISSIONS.savePortalSettings);
    const saved = await this.store.saveSettings(
      scope.tx,
      { slug: body.slug, enabled: body.enabled, whistleEnabled: body.whistle_enabled, title: body.title, publisherName: body.publisher_name, idPrefix: body.id_prefix, licenseUri: body.license_uri, policyUri: body.policy_uri },
      body.expected_version,
      scope.tenant.membershipId,
      todayOf(new Date()),
    );
    await scope.audit({ action: 'prj.portal_settings_saved', resourceType: SETTING, resourceId: saved.id, diff: { slug: saved.slug, enabled: saved.enabled, whistle_enabled: saved.whistleEnabled, allowed_fields: saved.allowedFields, policy_rule_version: saved.policyRuleVersion } });
    await scope.emit({ aggregateType: SETTING, aggregateId: saved.id, aggregateVersion: saved.version, type: 'prj.portal_settings.saved.v1', schemaVersion: 1, payload: { tenant_id: scope.tenant.tenantId, slug: saved.slug, enabled: saved.enabled, actor_id: scope.tenant.membershipId }, eventKey: `${SETTING}:${saved.id}:${saved.version}` });
    return commandResult(scope, saved.enabled ? 'ENABLED' : 'DISABLED', saved.version, saved.id);
  }

  @Post('portal/records')
  @HttpCode(200)
  @OperationId('publishPortalRecord')
  @Command({ operation: 'publishPortalRecord' })
  async publish(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['PublishPortalRecord']): Promise<CommandResult> {
    assertWholeTenant(access, PERMISSIONS.publishPortalRecord);
    const { record, change } = await this.store.publish(scope.tx, body.project_id.toLowerCase(), { summary: body.summary, sector: body.sector, projectType: body.project_type, purpose: body.purpose }, scope.tenant.membershipId, todayOf(new Date()));
    if (change === 'UNCHANGED') await scope.audit({ action: 'prj.portal_record_publish_repeated', resourceType: RECORD, resourceId: record.id, classification: 'PUBLIC', diff: { outcome: 'UNCHANGED', project_id: record.projectId, revision: record.revision, fields_sha256: record.fieldsSha256 } });
    else {
      // The audit row carries the hash and the field names, not the published text; the published text is the portal record itself.
      await scope.audit({ action: `prj.portal_record_${change.toLowerCase()}`, resourceType: RECORD, resourceId: record.id, classification: 'PUBLIC', diff: { project_id: record.projectId, public_code: record.publicCode, revision: record.revision, fields_sha256: record.fieldsSha256, fields: Object.keys(record.fields) } });
      await scope.emit({ aggregateType: RECORD, aggregateId: record.id, aggregateVersion: record.version, type: 'prj.portal_record.published.v1', schemaVersion: 1, payload: { tenant_id: scope.tenant.tenantId, project_id: record.projectId, revision: record.revision, fields_sha256: record.fieldsSha256, actor_id: scope.tenant.membershipId }, eventKey: `${RECORD}:${record.id}:${record.revision}` });
    }
    return commandResult(scope, change, record.version, record.id);
  }

  @Post('portal/records/:project_id/withdraw')
  @HttpCode(200)
  @OperationId('withdrawPortalRecord')
  @Command({ operation: 'withdrawPortalRecord' })
  async withdraw(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('project_id', ParseUUIDPipe) projectId: string, @Body() body: Schemas['Gov12Reason']): Promise<CommandResult> {
    assertWholeTenant(access, PERMISSIONS.withdrawPortalRecord);
    const record = await this.store.withdraw(scope.tx, projectId.toLowerCase(), body.reason, scope.tenant.membershipId);
    await scope.audit({ action: 'prj.portal_record_withdrawn', resourceType: RECORD, resourceId: record.id, classification: 'PUBLIC', diff: { project_id: record.projectId, public_code: record.publicCode, revision: record.revision }, reason: body.reason.trim() });
    await scope.emit({ aggregateType: RECORD, aggregateId: record.id, aggregateVersion: record.version, type: 'prj.portal_record.withdrawn.v1', schemaVersion: 1, payload: { tenant_id: scope.tenant.tenantId, project_id: record.projectId, actor_id: scope.tenant.membershipId }, eventKey: `${RECORD}:${record.id}:withdrawn:${record.version}` });
    return commandResult(scope, 'WITHDRAWN', record.version, record.id);
  }
}

/** The public portal, publisher side, reads: the settings, what is published, and the OC4IDS export with the problems of the standard's required fields. */
@Controller()
export class PortalReadsController {
  private readonly store = new PortalStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('portal/settings')
  @OperationId('getPortalSettings')
  async settings(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess): Promise<Record<string, unknown>> {
    assertWholeTenant(access, PERMISSIONS.getPortalSettings);
    const today = todayOf(new Date());
    const found = await this.database.withTenant(tenant, async (tx) => ({ setting: await this.store.setting(tx), policy: await this.store.policy(tx, today) }));
    return {
      as_of: today,
      settings: settingView(found.setting),
      catalogue: [...PORTAL_FIELDS],
      // The rule in force today, so that the publisher sees whether the copy in the settings is stale.
      rule: { version: found.policy.version, unverified: found.policy.unverified, allowed_fields: found.policy.policy.allowed_fields, rate_per_minute: found.policy.policy.rate_per_minute, page_size_max: found.policy.policy.page_size_max },
    };
  }

  @Get('portal/records')
  @OperationId('listPortalRecords')
  async records(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('include_withdrawn') includeWithdrawn?: unknown, @Query('limit') limit?: unknown, @Query('offset') offset?: unknown): Promise<Record<string, unknown>> {
    assertWholeTenant(access, PERMISSIONS.listPortalRecords);
    const page = pageOf(limit, offset);
    const rows = await this.database.withTenant(tenant, (tx) => this.store.records(tx, { includeWithdrawn: booleanQuery(includeWithdrawn, 'include_withdrawn'), limit: page.limit + 1, offset: page.offset }));
    return { as_of: todayOf(new Date()), items: rows.slice(0, page.limit).map(recordView), has_more: rows.length > page.limit };
  }

  @Get('portal/oc4ids')
  @OperationId('exportPortalOc4ids')
  async oc4ids(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess): Promise<Record<string, unknown>> {
    assertWholeTenant(access, PERMISSIONS.exportPortalOc4ids);
    const now = new Date();
    const exported = await this.database.withTenant(tenant, (tx) => this.store.exportOc4ids(tx, now));
    if (exported === undefined) throw new DomainError('PORTAL_NOT_CONFIGURED', 409);
    return {
      as_of: todayOf(now),
      version: OC4IDS_VERSION,
      required_fields: [...OC4IDS_PROJECT_REQUIRED],
      lists: { source: OC4IDS_LISTS_STATUS.source, legal_status: OC4IDS_LISTS_STATUS.legalStatus },
      complete: exported.issues.length === 0,
      issues: exported.issues,
      package: exported.package,
    };
  }
}
