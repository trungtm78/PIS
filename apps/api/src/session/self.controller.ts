import { Body, Controller, Get, HttpCode, Inject, Injectable, Param, ParseUUIDPipe, Post, Put, Req } from '@nestjs/common';
import { IamSelfStore, TenantDatabase } from '@machvon/db';
import type { ProfileRecord } from '@machvon/db';
import { DomainError, parseProfilePatch } from '@machvon/kernel';
import type { TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../command.decorator';
import { commandResult } from '../command-result';
import type { CommandResult } from '../command-result';
import type { CommandScope } from '../command-scope';
import type { Schemas } from '../contract-types';
import { OperationId } from '../operation-id.decorator';
import { principalOf } from '../principal';
import { CurrentTenant } from '../tenant-context.decorator';

/** The deny-list the authentication guard consults, as the revocations of a person reach it (a session revoked here is refused at once in this process; the others see it within their negative TTL, BR-IAM-13). */
export const SESSION_REVOCATION = Symbol('SESSION_REVOCATION');
export interface SessionRevocationSink {
  revoke(sessionId: string): void;
}

/** The identity provider's end of a sign-out (Keycloak back-channel logout): ends the provider's session of the one revoked. A failure here never undoes the revocation, which already holds in the platform. */
export const IDENTITY_LOGOUT = Symbol('IDENTITY_LOGOUT');
export interface IdentityLogout {
  logout(idpSessionId: string): Promise<void>;
}

/** Used until the identity provider is connected: the platform's own deny-list is what refuses the session. */
@Injectable()
export class NoIdentityLogout implements IdentityLogout {
  logout(): Promise<void> {
    return Promise.resolve();
  }
}

const SESSION_RESOURCE = 'user_session';
const DEVICE_RESOURCE = 'device_registration';
const PROFILE_RESOURCE = 'user_account';
const SESSION_REVOKE_REASON = 'USER_REVOKED';

function profileView(profile: ProfileRecord): Record<string, unknown> {
  return { id: profile.userId, display_name: profile.displayName, email_masked: profile.emailMasked, phone_masked: profile.phoneMasked, locale: profile.locale, time_zone: profile.timeZone, version: profile.version };
}

function reasonOf(body: Schemas['ReasonOnly']): string {
  const reason = typeof body.reason === 'string' ? body.reason.normalize('NFC').trim() : '';
  if (reason.length < 10 || reason.length > 2000) throw new DomainError('VALIDATION_FAILED', 422, 'reason');
  return reason;
}

/**
 * What a person does with themselves (ST-IAM-006, IAM 3.4): edits their profile at the version they read, signs out their other sessions and removes their devices. Everything is of the caller's own membership;
 * another member's session or device is not there for them (404). A revoked session is refused within the revocation budget of 60 seconds (BR-IAM-13): here, at once.
 */
@Controller()
export class SelfServiceController {
  private readonly self = new IamSelfStore();

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Inject(SESSION_REVOCATION) private readonly revocation: SessionRevocationSink,
    @Inject(IDENTITY_LOGOUT) private readonly identity: IdentityLogout,
  ) {}

  @Get('me/profile')
  @OperationId('getMyProfile')
  async profile(@CurrentTenant() tenant: TenantContext): Promise<Record<string, unknown>> {
    return profileView(await this.database.withTenant(tenant, (tx) => this.self.profile(tx, tenant.membershipId)));
  }

  @Put('me/profile')
  @HttpCode(200)
  @OperationId('updateMyProfile')
  @Command({ operation: 'updateMyProfile', versioned: true })
  async updateProfile(@Scope() scope: CommandScope, @Body() body: Schemas['ProfileUpdate']): Promise<Record<string, unknown>> {
    const patch = parseProfilePatch(body as Record<string, unknown>);
    const profile = await this.self.updateProfile(scope.tx, scope.tenant.membershipId, scope.expectedVersion ?? 0, patch);
    // The audit names the fields that changed, never their values (a name and a phone number are personal data).
    await scope.audit({ action: 'user.profile_updated', resourceType: PROFILE_RESOURCE, resourceId: profile.userId, diff: { fields: Object.keys(body as Record<string, unknown>).sort(), version: profile.version } });
    return profileView(profile);
  }

  @Get('me/sessions')
  @OperationId('listMySessions')
  async sessions(@CurrentTenant() tenant: TenantContext, @Req() request: object): Promise<{ items: Array<Record<string, unknown>>; as_of: string }> {
    const current = principalOf(request).sessionId;
    const rows = await this.database.withTenant(tenant, (tx) => this.self.sessions(tx, tenant.membershipId));
    return {
      items: rows.map((row) => ({
        id: row.id,
        // The session the request is made with: the screen offers no revoke for it.
        current: row.id === current,
        assurance_level: row.assurance,
        user_agent_summary: row.userAgentSummary,
        created_at: row.createdAt,
        last_seen_at: row.lastSeenAt,
        device: row.deviceId === null ? null : { id: row.deviceId, platform: row.devicePlatform },
      })),
      as_of: new Date().toISOString(),
    };
  }

  @Get('me/devices')
  @OperationId('listMyDevices')
  async devices(@CurrentTenant() tenant: TenantContext): Promise<{ items: Array<Record<string, unknown>>; as_of: string }> {
    const rows = await this.database.withTenant(tenant, (tx) => this.self.devices(tx, tenant.membershipId));
    return {
      items: rows.map((row) => ({ id: row.id, platform: row.platform, device_public_id: row.devicePublicId, last_seen_at: row.lastSeenAt, revoked_at: row.revokedAt, status: row.revokedAt === null ? 'ACTIVE' : 'REVOKED' })),
      as_of: new Date().toISOString(),
    };
  }

  @Post('me/sessions/:sessionId/revoke')
  @HttpCode(200)
  @OperationId('revokeMySession')
  @Command({ operation: 'revokeMySession' })
  async revokeSession(@Scope() scope: CommandScope, @Req() request: object, @Param('sessionId', ParseUUIDPipe) sessionId: string, @Body() body: Schemas['ReasonOnly']): Promise<CommandResult> {
    const reason = reasonOf(body);
    const id = sessionId.toLowerCase();
    const done = await this.self.revokeSession(scope.tx, scope.tenant.membershipId, id, principalOf(request).sessionId, SESSION_REVOKE_REASON);
    if (!done.alreadyRevoked) {
      await scope.audit({ action: 'session.revoked', resourceType: SESSION_RESOURCE, resourceId: id, reason, diff: { device_revoked: done.revokedDeviceId !== null, sessions_revoked: done.revokedSessionIds.length } });
      await scope.emit({
        aggregateType: SESSION_RESOURCE,
        aggregateId: id,
        aggregateVersion: 1,
        type: 'iam.session.revoked.v1',
        schemaVersion: 1,
        payload: { tenant_id: scope.tenant.tenantId, session_id: id, membership_id: scope.tenant.membershipId, device_id: done.revokedDeviceId, occurred_at: new Date().toISOString() },
        eventKey: `${SESSION_RESOURCE}:${id}:revoked`,
      });
      if (done.revokedDeviceId !== null) await this.deviceRevoked(scope, done.revokedDeviceId, done.revokedSessionIds);
      // After the commit: the deny-list refuses the session at once, and the identity provider ends its own.
      scope.afterCommit(() => this.cut(done.revokedSessionIds, done.idpSessionIds));
    } else {
      // Asking again changes nothing, but the request is on the record all the same.
      await scope.audit({ action: 'session.revoke_repeated', resourceType: SESSION_RESOURCE, resourceId: id, reason, diff: {} });
    }
    return commandResult(scope, 'REVOKED', 1, id);
  }

  @Post('me/devices/:deviceId/revoke')
  @HttpCode(200)
  @OperationId('revokeMyDevice')
  @Command({ operation: 'revokeMyDevice' })
  async revokeDevice(@Scope() scope: CommandScope, @Param('deviceId', ParseUUIDPipe) deviceId: string, @Body() body: Schemas['ReasonOnly']): Promise<CommandResult> {
    const reason = reasonOf(body);
    const id = deviceId.toLowerCase();
    const done = await this.self.revokeDevice(scope.tx, scope.tenant.membershipId, id, SESSION_REVOKE_REASON);
    if (!done.alreadyRevoked) {
      await scope.audit({ action: 'device.revoked', resourceType: DEVICE_RESOURCE, resourceId: id, reason, diff: { sessions_revoked: done.revokedSessionIds.length } });
      await this.deviceRevoked(scope, id, done.revokedSessionIds);
      scope.afterCommit(() => this.cut(done.revokedSessionIds, done.idpSessionIds));
    } else {
      await scope.audit({ action: 'device.revoke_repeated', resourceType: DEVICE_RESOURCE, resourceId: id, reason, diff: {} });
    }
    return commandResult(scope, 'REVOKED', 1, id);
  }

  private async deviceRevoked(scope: CommandScope, deviceId: string, sessionIds: string[]): Promise<void> {
    await scope.emit({
      aggregateType: DEVICE_RESOURCE,
      aggregateId: deviceId,
      aggregateVersion: 1,
      type: 'iam.device.revoked.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, device_id: deviceId, membership_id: scope.tenant.membershipId, session_ids: sessionIds, occurred_at: new Date().toISOString() },
      eventKey: `${DEVICE_RESOURCE}:${deviceId}:revoked`,
    });
  }

  private async cut(sessionIds: readonly string[], idpSessionIds: readonly string[]): Promise<void> {
    for (const sessionId of sessionIds) this.revocation.revoke(sessionId);
    // The identity provider is told after the platform has already refused the session; if it cannot be reached the session stays refused here.
    await Promise.allSettled(idpSessionIds.map((idp) => this.identity.logout(idp)));
  }
}
