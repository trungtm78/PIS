import { Body, Controller, Get, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ControlDatabase, LicenseStore, PLATFORM_TENANT_ID, TenantDatabase } from '@machvon/db';
import type { LicenseRow, LicenseTransitionInput, SignatureCheck } from '@machvon/db';
import { DomainError, licenseStatusAt } from '@machvon/kernel';
import type { TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { LICENSE_KEYS } from './license-signer';
import type { LicenseKeyStore } from './license-signer';
import { TENANT_STATE_EFFECTS } from './tenant-state-effects';
import type { TenantStateEffects } from './tenant-state-effects';

const RESOURCE_TYPE = 'license';
export const LICENSE_ISSUED_EVENT = 'sas.license.issued.v1';
export const LICENSE_REVOKED_EVENT = 'sas.license.revoked.v1';
export const LICENSE_SUSPENDED_EVENT = 'sas.license.suspended.v1';
export const LICENSE_REINSTATED_EVENT = 'sas.license.reinstated.v1';
export const LICENSE_RENEWED_EVENT = 'sas.license.renewed.v1';
/** "Expiring" is a label of the screens, thirty days before valid_until; it changes no right (SAS 3.8). */
const EXPIRING_DAYS = 30;
const DAY_MS = 86_400_000;

/**
 * What the audit row and the event of an issued license say, for the command and for the provisioning saga (SAS 3.1 step 7).
 * Neither carries the signed claims or any key.
 */
export function licenseIssuedRecord(issued: LicenseRow): { diff: Record<string, unknown>; payload: Record<string, unknown>; eventKey: string } {
  return {
    diff: {
      serial: issued.serial,
      revision: issued.revision,
      edition: issued.edition,
      valid_from: issued.validFrom.toISOString(),
      valid_until: issued.validUntil.toISOString(),
      grace_until: issued.graceUntil.toISOString(),
      seats: issued.seats,
      key_id: issued.keyId,
      entitlement_version_id: issued.entitlementVersionId,
    },
    payload: {
      tenant_id: issued.tenantId,
      license_id: issued.id,
      serial: issued.serial,
      revision: issued.revision,
      edition: issued.edition,
      valid_from: issued.validFrom.toISOString(),
      valid_until: issued.validUntil.toISOString(),
      key_id: issued.keyId,
    },
    eventKey: `${RESOURCE_TYPE}:${issued.id}:issued`,
  };
}

/**
 * License commands (ST-SAS-003, SAS-12, SAS-15): control plane only, permission `system.license.manage` (a tenant token is
 * 403 whatever its roles, AC43). The server signs with its own entitlement and key: a client cannot send claims (BR-SAS-12).
 * The audit row and the events belong to the tenant of the license and never carry the signed claims or any key.
 */
@Controller('licenses')
export class LicenseController {
  constructor(
    @Inject(LicenseStore) private readonly store: LicenseStore,
    @Inject(LICENSE_KEYS) private readonly keys: LicenseKeyStore,
    @Optional() @Inject(TENANT_STATE_EFFECTS) private readonly effects?: TenantStateEffects,
  ) {}

  @Post()
  @HttpCode(201)
  @OperationId('post_licenses')
  @Command({ operation: 'post_licenses', plane: 'control' })
  async issue(@Scope() scope: CommandScope, @Body() body: Schemas['LicenseIssue']): Promise<CommandResult> {
    const license = await this.store.issue(
      scope.tx,
      {
        tenantId: body.tenant_id,
        edition: body.edition,
        validFrom: new Date(body.valid_from),
        validUntil: new Date(body.valid_until),
        graceUntil: new Date(body.grace_until),
        entitlementVersionId: body.entitlement_version_id,
        seats: body.seats,
        quota: body.quota,
        deploymentBinding: body.deployment_binding,
        offlineLeaseDays: body.offline_lease_days,
        issuedBy: scope.tenant.membershipId,
        restoreTenantId: scope.tenant.tenantId,
      },
      () => this.keys.current(),
      async (issued) => {
        const record = licenseIssuedRecord(issued);
        await scope.audit({ action: 'license.issued', resourceType: RESOURCE_TYPE, resourceId: issued.id, diff: record.diff });
        await scope.emit({
          aggregateType: RESOURCE_TYPE,
          aggregateId: issued.id,
          aggregateVersion: issued.version,
          type: LICENSE_ISSUED_EVENT,
          schemaVersion: 1,
          payload: record.payload,
          eventKey: record.eventKey,
        });
      },
    );
    this.invalidateAfterCommit(scope, license);
    return commandResult(scope, 'ISSUED', license.version, license.id);
  }

  @Post(':id/revoke')
  @HttpCode(200)
  @OperationId('post_licenses_id_revoke')
  @Command({ operation: 'post_licenses_id_revoke', plane: 'control', versioned: true })
  async revoke(@Scope() scope: CommandScope, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['ReasonOnly']): Promise<CommandResult> {
    const hook = this.recorded(scope, body.reason, 'revoked', LICENSE_REVOKED_EVENT, () => 'revoked');
    const license = await this.store.revoke(scope.tx, this.transitionOf(scope, id, body), hook);
    this.invalidateAfterCommit(scope, license);
    return commandResult(scope, 'REVOKED', license.version, license.id);
  }

  /** suspendLicense (SAS-15): a live license is put on hold; the tenant is denied until it is reinstated or revoked. */
  @Post(':id/suspend')
  @HttpCode(200)
  @OperationId('suspendLicense')
  @Command({ operation: 'suspendLicense', plane: 'control', versioned: true })
  async suspend(@Scope() scope: CommandScope, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['ReasonOnly']): Promise<CommandResult> {
    const hook = this.recorded(scope, body.reason, 'suspended', LICENSE_SUSPENDED_EVENT, (license) => `suspended:${license.version}`);
    const license = await this.store.suspend(scope.tx, this.transitionOf(scope, id, body), hook);
    this.invalidateAfterCommit(scope, license);
    return commandResult(scope, 'SUSPENDED', license.version, license.id);
  }

  /** reinstateLicense (SAS-15): a suspended license is judged by the clock again; a revoked one never is (BR-SAS-12). */
  @Post(':id/reinstate')
  @HttpCode(200)
  @OperationId('reinstateLicense')
  @Command({ operation: 'reinstateLicense', plane: 'control', versioned: true })
  async reinstate(@Scope() scope: CommandScope, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['ReasonOnly']): Promise<CommandResult> {
    const hook = this.recorded(scope, body.reason, 'reinstated', LICENSE_REINSTATED_EVENT, (license) => `reinstated:${license.version}`);
    const license = await this.store.reinstate(scope.tx, this.transitionOf(scope, id, body), hook);
    this.invalidateAfterCommit(scope, license);
    return commandResult(scope, 'REINSTATED', license.version, license.id);
  }

  /**
   * renewLicense (SAS-14): revision n+1 takes the place of a live revision n, which becomes Superseded; both stay signed. The new term, the seats and the entitlement version are
   * the request's; the edition, the quota and the binding are those of the revision it replaces. The audit row carries the reason, the two revisions and the new window, never the claims.
   */
  @Post(':id/renew')
  @HttpCode(200)
  @OperationId('renewLicense')
  @Command({ operation: 'renewLicense', plane: 'control', versioned: true })
  async renew(@Scope() scope: CommandScope, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['LicenseRenew']): Promise<CommandResult> {
    const renewed = await this.store.renew(
      scope.tx,
      {
        licenseId: id,
        reason: body.reason,
        expectedVersion: scope.expectedVersion ?? 0,
        validUntil: new Date(body.valid_until),
        graceUntil: new Date(body.grace_until),
        seats: body.seats,
        entitlementVersionId: body.entitlement_version_id,
        issuedBy: scope.tenant.membershipId,
        restoreTenantId: scope.tenant.tenantId,
      },
      () => this.keys.current(),
      async ({ license, superseded }) => {
        const record = licenseIssuedRecord(license);
        await scope.audit({
          action: 'license.renewed',
          resourceType: RESOURCE_TYPE,
          resourceId: license.id,
          reason: body.reason.trim(),
          diff: { ...record.diff, supersedes_id: superseded.id, superseded_revision: superseded.revision, previous_valid_until: superseded.validUntil.toISOString() },
        });
        await scope.emit({
          aggregateType: RESOURCE_TYPE,
          aggregateId: license.id,
          aggregateVersion: license.version,
          type: LICENSE_RENEWED_EVENT,
          schemaVersion: 1,
          payload: { ...record.payload, supersedes_id: superseded.id, superseded_revision: superseded.revision },
          eventKey: `${RESOURCE_TYPE}:${license.id}:renewed`,
        });
      },
    );
    this.invalidateAfterCommit(scope, renewed.license);
    return commandResult(scope, 'RENEWED', renewed.license.version, renewed.license.id);
  }

  private transitionOf(scope: CommandScope, id: string, body: Schemas['ReasonOnly']): LicenseTransitionInput {
    return { licenseId: id, reason: body.reason, expectedVersion: scope.expectedVersion ?? 0, restoreTenantId: scope.tenant.tenantId };
  }

  // The audit row and the event of a change of state, written while the transaction acts as the tenant of the license.
  private recorded(scope: CommandScope, reason: string, action: string, type: string, keyOf: (license: LicenseRow) => string): (license: LicenseRow) => Promise<void> {
    return async (license) => {
      await scope.audit({
        action: `license.${action}`,
        resourceType: RESOURCE_TYPE,
        resourceId: license.id,
        reason: license.statusReason ?? reason.trim(),
        diff: { serial: license.serial, revision: license.revision, status: license.status },
      });
      await scope.emit({
        aggregateType: RESOURCE_TYPE,
        aggregateId: license.id,
        aggregateVersion: license.version,
        type,
        schemaVersion: 1,
        payload: { tenant_id: license.tenantId, license_id: license.id, serial: license.serial, revision: license.revision },
        eventKey: `${RESOURCE_TYPE}:${license.id}:${keyOf(license)}`,
      });
    };
  }

  // A license changes what the tenant may do: the entitlements and the effective access it cached are dropped once the change is committed.
  private invalidateAfterCommit(scope: CommandScope, license: LicenseRow): void {
    const effects = this.effects;
    if (effects !== undefined) scope.afterCommit(() => effects.invalidate(license.tenantId));
  }
}

/** The state of a revision as a person reads it: what the clock says, except for the labels people set (suspended, revoked) or the history (draft, superseded). */
export function effectiveStatus(row: LicenseRow, now: Date): string {
  if (row.status === 'Draft' || row.status === 'Superseded' || row.status === 'Suspended') return row.status;
  return licenseStatusAt({ validFrom: row.validFrom, validUntil: row.validUntil, graceUntil: row.graceUntil, status: row.status }, now);
}

/** SystemLicense of the control plane (SAS-13): the whole revision and the result of checking its signature; the signed claims stay in the table. */
export function systemLicenseView(row: LicenseRow, now: Date, signatureCheck: SignatureCheck): Schemas['SystemLicense'] {
  const status = effectiveStatus(row, now);
  return {
    id: row.id,
    tenant_id: row.tenantId,
    serial: row.serial,
    revision: row.revision,
    edition: row.edition,
    status: status as Schemas['SystemLicense']['status'],
    valid_from: row.validFrom.toISOString(),
    valid_until: row.validUntil.toISOString(),
    grace_until: row.graceUntil.toISOString(),
    seats: row.seats,
    quota: row.quota,
    issuer: row.issuer,
    issued_by: row.issuedBy,
    issued_at: row.issuedAt?.toISOString() ?? null,
    status_reason: row.statusReason,
    deployment_binding: row.deploymentBinding,
    offline_lease_until: row.offlineLeaseUntil?.toISOString() ?? null,
    key_id: row.keyId,
    entitlement_version_id: row.entitlementVersionId,
    supersedes_id: row.supersedesId,
    signature_check: signatureCheck,
    expiring: status === 'Active' && row.validUntil.getTime() - now.getTime() <= EXPIRING_DAYS * DAY_MS,
    version: row.version,
  };
}

/** openapi.json license_revision item for the tenant plane (`x-exposure: dto`): edition, validity and state; the signed claims and the key stay with the control plane. */
export function licenseView(row: LicenseRow, now: Date): Record<string, unknown> {
  const status = effectiveStatus(row, now);
  return {
    id: row.id,
    serial: row.serial,
    revision: row.revision,
    edition: row.edition,
    status,
    valid_from: row.validFrom.toISOString(),
    valid_until: row.validUntil.toISOString(),
    grace_until: row.graceUntil.toISOString(),
    seats: row.seats,
    issued_at: row.issuedAt?.toISOString() ?? null,
    expiring: status === 'Active' && row.validUntil.getTime() - now.getTime() <= EXPIRING_DAYS * DAY_MS,
    version: row.version,
  };
}

/** The license of the caller's own tenant (get_resources_license_revision and its id form): a tenant never sees another tenant's license. */
@Controller('resources/license_revision')
export class LicenseReadsController {
  constructor(
    @Inject(LicenseStore) private readonly store: LicenseStore,
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
  ) {}

  @Get()
  @OperationId('get_resources_license_revision')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null }> {
    const request = parsePageRequest(limit, cursor);
    const rows = await this.database.withTenant(tenant, (tx) => this.store.list(tx, { limit: request.limit + 1, after: request.after }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    const now = new Date();
    return {
      items: shown.map((row) => licenseView(row, now)),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.serial, id: last.id }) : null,
    };
  }

  @Get(':id')
  @OperationId('get_resources_license_revision_id')
  async get(@CurrentTenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const row = await this.database.withTenant(tenant, (tx) => this.store.find(tx, id));
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return licenseView(row, new Date());
  }
}

/**
 * The licenses of any tenant for the control plane (SAS-13, SAS-15): `system.tenant.read` like the registry reads, so a
 * Platform Operator reads what a System Admin changes. The read runs on the control database under the platform tenant and
 * acts as the tenant of the license while it selects; the signature is checked against the registered public keys on every read.
 */
@Controller('system')
export class SystemLicenseReadsController {
  constructor(
    @Inject(LicenseStore) private readonly store: LicenseStore,
    @Inject(LICENSE_KEYS) private readonly keys: LicenseKeyStore,
    @Inject(ControlDatabase) private readonly control: ControlDatabase,
  ) {}

  @Get('licenses/:id')
  @OperationId('getSystemLicense')
  async get(@Param('id', ParseUUIDPipe) id: string): Promise<Schemas['SystemLicense']> {
    const row = await this.control.withTenantOf(PLATFORM_TENANT_ID, (tx) => this.store.findAny(tx, id, PLATFORM_TENANT_ID));
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return systemLicenseView(row, new Date(), this.store.verifySignature(row, await this.keys.publicKeys()));
  }

  @Get('tenants/:tenantId/licenses')
  @OperationId('listSystemTenantLicenses')
  async list(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<Schemas['SystemLicensePage']> {
    const request = parsePageRequest(limit, cursor);
    const rows = await this.control.withTenantOf(PLATFORM_TENANT_ID, (tx) => this.store.listOf(tx, tenantId, { limit: request.limit + 1, after: request.after }, PLATFORM_TENANT_ID));
    if (rows === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    const now = new Date();
    const publicKeys = await this.keys.publicKeys();
    return {
      items: shown.map((row) => systemLicenseView(row, now, this.store.verifySignature(row, publicKeys))),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.serial, id: last.id }) : null,
    };
  }
}
