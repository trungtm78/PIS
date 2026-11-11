import { createHash, randomUUID } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { DeviceRegistrationStore, TenantDatabase } from '@machvon/db';
import type { DeviceRegistrationRecord } from '@machvon/db';
import { DomainError, asUuid } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { holdsOnWholeTenant } from '../../modules/adm/tenant-authority';
import { OperationId } from '../../operation-id.decorator';
import { principalOf } from '../../principal';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { PUSH_TOKEN_VAULT, pushSecretRefOf } from './push-vault';
import type { PushTokenVault } from './push-vault';

const READ = PERMISSIONS.get_resources_device_registration;
const DEVICE_RESOURCE = 'device_registration';
const DEVICE_PUBLIC_ID = /^[A-Za-z0-9._:-]{16,128}$/;
const APP_VERSION = /^[0-9A-Za-z.+_-]{1,40}$/;
const LOCALE = /^[a-z]{2}-[A-Z]{2}$/;
const STATUSES: readonly string[] = ['Active', 'Revoked'];
const PLATFORMS: readonly string[] = ['ios', 'android', 'web'];
const PERMISSION_STATES: readonly string[] = ['granted', 'denied', 'provisional', 'unknown', 'unavailable'];

/** The shape of the public id that is shown: enough to tell two devices apart, never the whole of it. */
export function deviceHint(devicePublicId: string): string {
  return devicePublicId.length <= 8 ? '*'.repeat(devicePublicId.length) : `${devicePublicId.slice(0, 4)}…${devicePublicId.slice(-4)}`;
}

function viewOf(row: DeviceRegistrationRecord): Schemas['DeviceRegistration'] {
  return {
    id: row.id,
    membership_id: row.membershipId,
    platform: row.platform as Schemas['DeviceRegistration']['platform'],
    device_hint: deviceHint(row.devicePublicId),
    permission_state: row.permissionState as Schemas['DeviceRegistration']['permission_state'],
    app_version: row.appVersion,
    locale: row.locale,
    last_seen_at: row.lastSeenAt,
    status: row.revokedAt === null ? 'Active' : 'Revoked',
    revoked_at: row.revokedAt,
    revoke_reason: row.revokeReason,
  };
}

/**
 * The push devices (ST-NOT-006, NOT 3.7). A member registers their own device: once for each device, whatever the number of times the app asks, with the token the provider gave it. The token goes to the vault and the
 * database keeps its fingerprint; it is never in an answer, an audit row or an event. The token is optional (FIXAE-1): the registration is also what gives the app the id of its device for the offline command queue, so a build
 * without a push provider, or a person who refused the permission, registers with no token and is simply never a push target; registering again with a token later is the same registration. The operators of the tenant read the devices without the token and without the whole public id of the device (NOT-14). A device that
 * the member removes, or whose session ends, is revoked by IAM (ST-IAM-006), which takes the token out of the vault.
 */
@Controller()
export class DeviceRegistrationsController {
  private readonly store = new DeviceRegistrationStore();

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Inject(PUSH_TOKEN_VAULT) private readonly vault: PushTokenVault,
  ) {}

  @Post('devices')
  @HttpCode(201)
  @OperationId('registerDevice')
  @Command({ operation: 'registerDevice' })
  async register(@Scope() scope: CommandScope, @Req() request: object, @Body() body: Schemas['DeviceRegister']): Promise<CommandResult> {
    if (body.push_token !== undefined && typeof body.push_token !== 'string') throw new DomainError('VALIDATION_FAILED', 422, 'push_token');
    // An empty token is no token: the device has none (the app has nothing to send), which is a registration of its own kind.
    const token = body.push_token?.trim() ?? '';
    if (!PERMISSION_STATES.includes(body.permission_state)) throw new DomainError('VALIDATION_FAILED', 422, 'permission_state');
    // A device with a token has a provider: it cannot say that it has none. (The other states are the operating system's to say; a token with 'denied' is revoked at the provider and ignored when pushing.)
    if (token !== '' && body.permission_state === 'unavailable') throw new DomainError('VALIDATION_FAILED', 422, 'permission_state');
    if (!DEVICE_PUBLIC_ID.test(body.device_public_id)) throw new DomainError('VALIDATION_FAILED', 422, 'device_public_id');
    if (!APP_VERSION.test(body.app_version)) throw new DomainError('VALIDATION_FAILED', 422, 'app_version');
    const locale = body.locale ?? 'vi-VN';
    if (!LOCALE.test(locale)) throw new DomainError('VALIDATION_FAILED', 422, 'locale');
    const newId = randomUUID();
    const registered = await this.store.register(
      scope.tx,
      {
        membershipId: scope.tenant.membershipId,
        devicePublicId: body.device_public_id,
        platform: body.platform,
        permissionState: body.permission_state,
        appVersion: body.app_version,
        locale,
        tokenFingerprint: token === '' ? undefined : createHash('sha256').update(token, 'utf8').digest('hex'),
      },
      newId,
      pushSecretRefOf(scope.tenant.tenantId, newId),
    );
    // The token is written inside the command, every time the app registers: a vault that lost it (a restart of the stand-in, a vault restored from an older copy) is repaired by the next registration, and a vault that
    // cannot be reached fails the command whole. The row is locked until the commit, so the token read here is the one this command overwrites. If the command is rolled back, the vault goes back to what it held: a
    // registration that was new takes its token away, a rotation puts the previous token back.
    // Every new token has a reference of its own, so no command ever overwrites a token that another command may still need: a command that does not commit removes the token it wrote (the row goes back to its
    // old reference with the transaction, and the old token was never touched), and one that commits removes the token it replaced. A repeated registration of the same token writes the same value to the same place.
    const secretRef = registered.secretRef;
    if (secretRef !== undefined) {
      if (registered.tokenChanged) scope.afterRollback(() => this.vault.remove(secretRef));
      await this.vault.put(secretRef, token);
    }
    const replaced = registered.previousRef;
    if (replaced !== undefined) scope.afterCommit(() => this.vault.remove(replaced));
    // The session the request is made with belongs to this device from now on, so that removing the device signs the session out and signing the session out removes the device and its token (IAM, ST-IAM-006).
    const sessionId = asUuid(principalOf(request).sessionId);
    if (sessionId !== undefined) {
      const bound = await scope.tx.query<{ id: string }>(
        'update machvon.user_session set device_registration_id = $1::uuid where id = $2::uuid and membership_id = $3::uuid and revoked_at is null returning id',
        [registered.id, sessionId, scope.tenant.membershipId],
      );
      // The session ended before this command got to it (the device was locked first, as the revocation locks it): nothing is registered for a session that is over.
      if (bound.length === 0) throw new DomainError('SESSION_EXPIRED', 401);
    }
    await scope.audit({
      action: registered.created ? 'device.registered' : 'device.updated',
      resourceType: DEVICE_RESOURCE,
      resourceId: registered.id,
      classification: 'PERSONAL',
      // The platform and the state of the permission only: no token, no fingerprint, no public id.
      diff: { platform: body.platform, permission_state: body.permission_state, app_version: body.app_version, token_changed: registered.tokenChanged, has_token: secretRef !== undefined },
    });
    return commandResult(scope, registered.created ? 'REGISTERED' : 'UPDATED', 1, registered.id);
  }

  @Get('resources/device_registration')
  @OperationId('get_resources_device_registration')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('status') status?: unknown,
    @Query('platform') platform?: unknown,
    @Query('membership_id') membershipId?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<Schemas['DeviceRegistrationPage']> {
    // The devices of all the members are the tenant's to see, not a unit's.
    if (!holdsOnWholeTenant(access, READ)) throw new DomainError('SCOPE_DENIED', 403);
    const request = parsePageRequest(limit, cursor);
    if (status !== undefined && (typeof status !== 'string' || !STATUSES.includes(status))) throw new DomainError('VALIDATION_FAILED', 422, 'status');
    if (platform !== undefined && (typeof platform !== 'string' || !PLATFORMS.includes(platform))) throw new DomainError('VALIDATION_FAILED', 422, 'platform');
    const member = membershipId === undefined ? undefined : asUuid(membershipId);
    if (membershipId !== undefined && member === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'membership_id');
    const filters = { status: status as 'Active' | 'Revoked' | undefined, platform: platform as string | undefined, membershipId: member };
    const rows = await this.database.withTenant(tenant, (tx) => this.store.list(tx, filters, { limit: request.limit + 1, after: request.after }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return { items: shown.map(viewOf), next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.sortKey, id: last.id }) : null, as_of: new Date().toISOString() };
  }

  @Get('resources/device_registration/:id')
  @OperationId('get_resources_device_registration_id')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Schemas['DeviceRegistration']> {
    if (!holdsOnWholeTenant(access, READ)) throw new DomainError('SCOPE_DENIED', 403);
    const found = await this.database.withTenant(tenant, (tx) => this.store.find(tx, id.toLowerCase()));
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return viewOf(found);
  }
}
