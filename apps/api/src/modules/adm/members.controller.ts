import { Body, Controller, HttpCode, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { MemberStore, RoleStore, bumpScopeVersion } from '@machvon/db';
import type { MemberRecord, UnitRecord } from '@machvon/db';
import { DomainError, effectivePermissions, holdsPermission, maxRank, versionConflict } from '@machvon/kernel';
import type { EffectiveAccess, Scope as GrantScope } from '@machvon/kernel';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import { Command, Scope } from '../../command.decorator';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { assertVerdict, grantCreateOf } from '../../iam-dto';
import { OperationId } from '../../operation-id.decorator';
import { authorise } from '../../role-grants.controller';
import { deliverInvitation, issueInvitation } from './invitation-delivery';
import { INVITATION_MAILER } from './invitation-mailer';
import type { InvitationMailer } from './invitation-mailer';

const INVITE_PERMISSION = PERMISSIONS.inviteMember;
const MANAGE_PERMISSION = PERMISSIONS.endMembership;
const DEFAULT_ROLE = 'MEMBER';
const SESSIONS_REVOKED_REASON = 'MEMBERSHIP_CHANGED';

type Lifecycle = 'suspend' | 'reactivate' | 'end';

// What each command does to a membership: the states it may start from and the state it leads to.
const TRANSITIONS: Readonly<Record<Lifecycle, { from: readonly MemberRecord['status'][]; to: MemberRecord['status']; label: string; event: string }>> = {
  suspend: { from: ['Active'], to: 'Suspended', label: 'SUSPENDED', event: 'iam.membership.suspended.v1' },
  reactivate: { from: ['Suspended'], to: 'Active', label: 'ACTIVE', event: 'iam.membership.activated.v1' },
  end: { from: ['Invited', 'Active', 'Suspended'], to: 'Ended', label: 'ENDED', event: 'iam.membership.ended.v1' },
};

function unitScopeOf(unit: Pick<UnitRecord, 'id' | 'path'>): GrantScope {
  return { kind: 'UNIT_ONLY', refIds: [unit.id], paths: [unit.path] };
}

function reaches(access: EffectiveAccess, permission: string, unit: Pick<UnitRecord, 'id' | 'path'>, now: Date): boolean {
  return holdsPermission(effectivePermissions(access, now, { ownerUnitPath: unit.path, ownerUnitId: unit.id }), permission);
}

/**
 * Members and invitations (ADM-02, ST-ADM-006 backend): invite a person into a unit, and suspend, reactivate or end a
 * membership. Every command runs in the command transaction with its audit row and its events; a change of access
 * raises the member's scope_version so the next request re-evaluates it (BR-IAM-13).
 */
@Controller('memberships')
export class MembersController {
  private readonly roles = new RoleStore();
  private readonly members = new MemberStore();

  constructor(@Inject(INVITATION_MAILER) private readonly mailer: InvitationMailer) {}

  @Post('invitations')
  @HttpCode(201)
  @OperationId('inviteMember')
  @Command({ operation: 'inviteMember' })
  async invite(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['MemberInvite']): Promise<CommandResult> {
    const now = new Date();
    const unit = await this.members.unitOf(scope.tx, body.organization_unit_id);
    if (unit === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (!reaches(access, INVITE_PERMISSION, unit, now)) throw new DomainError('SCOPE_DENIED', 403);
    if (unit.status !== 'Active') throw new DomainError('VALIDATION_FAILED', 422, 'organization_unit_id');
    const validUntil = body.valid_until === undefined ? undefined : new Date(body.valid_until);
    if (validUntil !== undefined && validUntil.getTime() <= now.getTime()) throw new DomainError('VALIDATION_FAILED', 422, 'valid_until');

    // An invitation does not hold a seat, but a tenant with no seat free does not invite (the seat is taken, and judged again, when it is accepted).
    await this.members.assertSeatFree(scope.tx, 'STAFF');
    const userAccountId = await this.members.ensureInvitedAccount(scope.tx, body.email, body.display_name);
    const member = await this.members.insertInvitedMember(scope.tx, {
      userAccountId,
      organizationId: unit.id,
      membershipType: 'STAFF',
      validUntil,
      invitedBy: scope.tenant.membershipId,
    });
    const roleCodes = await this.grantInitialRoles(scope, access, member.id, unit, body.initial_grants ?? [], now);

    const invitation = await issueInvitation(scope, this.members, { membershipId: member.id, email: body.email, now });
    await scope.emit({
      aggregateType: 'membership',
      aggregateId: member.id,
      aggregateVersion: 1,
      type: 'iam.membership.invited.v1',
      schemaVersion: 1,
      payload: { membership_id: member.id, type: 'STAFF', unit_id: unit.id },
      eventKey: `membership-invited:${member.id}`,
    });
    // The audit row and the event carry no email and no token: the email is in the account, the token only goes to the person.
    await scope.audit({
      action: 'membership.invite',
      resourceType: 'membership',
      resourceId: member.id,
      diff: { organization_unit_id: unit.id, role_codes: roleCodes, expires_at: invitation.expiresAt.toISOString() },
    });
    await deliverInvitation(this.mailer, scope, invitation);
    return commandResult(scope, 'INVITED', member.version, member.id);
  }

  @Post(':membershipId/suspend')
  @HttpCode(200)
  @OperationId('suspendMembership')
  @Command({ operation: 'suspendMembership', versioned: true })
  suspend(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('membershipId', ParseUUIDPipe) id: string, @Body() body: Schemas['ReasonOnly']): Promise<CommandResult> {
    return this.change(scope, access, id, 'suspend', body.reason);
  }

  @Post(':membershipId/reactivate')
  @HttpCode(200)
  @OperationId('reactivateMembership')
  @Command({ operation: 'reactivateMembership', versioned: true })
  reactivate(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('membershipId', ParseUUIDPipe) id: string, @Body() body: Schemas['ReasonOnly']): Promise<CommandResult> {
    return this.change(scope, access, id, 'reactivate', body.reason);
  }

  @Post(':membershipId/end')
  @HttpCode(200)
  @OperationId('endMembership')
  @Command({ operation: 'endMembership', versioned: true })
  end(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('membershipId', ParseUUIDPipe) id: string, @Body() body: Schemas['ReasonOnly']): Promise<CommandResult> {
    return this.change(scope, access, id, 'end', body.reason);
  }

  /** The initial grants of an invitation (BR-IAM-05 applies to each); without any, the person receives the MEMBER role on their unit. */
  private async grantInitialRoles(
    scope: CommandScope,
    access: EffectiveAccess,
    membershipId: string,
    unit: UnitRecord,
    specs: readonly Schemas['RoleGrantSpec'][],
    now: Date,
  ): Promise<string[]> {
    if (specs.length === 0) return this.grantDefaultRole(scope, membershipId, unit);
    const codes: string[] = [];
    for (const spec of specs) {
      const dto = grantCreateOf({ ...spec, membership_id: membershipId, reason: 'initial grant of the invitation' }, now.getTime());
      const role = await this.roles.findRole(scope.tx, dto.roleId);
      if (role === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      if (role.status !== 'Active') throw new DomainError('VALIDATION_FAILED', 422, 'role_id');
      const resolved = await this.roles.resolveScope(scope.tx, dto.scopeKind, dto.scopeRefIds);
      if (resolved === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'scope_ref_ids');
      assertVerdict(authorise(access, membershipId, role, resolved).verdict);
      await this.roles.insertGrant(scope.tx, {
        membershipId,
        roleId: dto.roleId,
        scopeKind: dto.scopeKind,
        scopeRefIds: dto.scopeRefIds,
        paths: resolved.paths,
        effectiveFrom: dto.effectiveFrom,
        effectiveUntil: dto.effectiveUntil,
        grantedBy: scope.tenant.membershipId,
        reason: dto.reason,
      });
      codes.push(role.code);
    }
    return codes;
  }

  /**
   * Without initial grants the person receives the MEMBER role on their unit: it is what every member needs to sign in
   * and is not a privilege the inviter hands out, so the permission of the inviter over the unit is all it takes.
   */
  private async grantDefaultRole(scope: CommandScope, membershipId: string, unit: UnitRecord): Promise<string[]> {
    const role = await this.members.activeRoleByCode(scope.tx, DEFAULT_ROLE);
    if (role === undefined) return [];
    await this.roles.insertGrant(scope.tx, {
      membershipId,
      roleId: role.id,
      scopeKind: 'UNIT_ONLY',
      scopeRefIds: [unit.id],
      paths: [unit.path],
      grantedBy: scope.tenant.membershipId,
      reason: 'default role of an invitation',
    });
    return [DEFAULT_ROLE];
  }

  private async change(scope: CommandScope, access: EffectiveAccess, membershipId: string, action: Lifecycle, reason: string): Promise<CommandResult> {
    const rule = TRANSITIONS[action];
    if (membershipId === scope.tenant.membershipId) throw new DomainError('SELF_ACTION_DENIED', 403);
    const member = await this.members.lockMember(scope.tx, membershipId);
    if (member === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const now = new Date();
    const unit = { id: member.organizationId, path: member.unitPath };
    if (!reaches(access, MANAGE_PERMISSION, unit, now)) throw new DomainError('SCOPE_DENIED', 403);
    // BR-IAM-07: the last tenant owner can neither be suspended nor ended, whoever asks.
    if (action !== 'reactivate' && (await this.members.isLastOwner(scope.tx, membershipId))) throw new DomainError('LAST_TENANT_OWNER', 409);
    // BR-IAM-05: nobody acts on a member who holds a role of their own rank or higher.
    if (maxRank(access, now, unitScopeOf(unit)) <= (await this.roles.highestRankOf(scope.tx, membershipId))) {
      throw new DomainError('ROLE_ESCALATION_DENIED', 403);
    }
    if (scope.expectedVersion !== null && scope.expectedVersion !== member.version) throw versionConflict(member.version);
    if (!rule.from.includes(member.status)) throw new DomainError('MEMBERSHIP_STATE_INVALID', 409);
    if (action === 'reactivate') await this.members.assertSeatFree(scope.tx, member.membershipType);

    const version = await this.members.setStatus(scope.tx, membershipId, rule.to, action === 'end' ? reason : undefined);
    if (action !== 'reactivate') await this.members.revokeSessions(scope.tx, membershipId, SESSIONS_REVOKED_REASON);
    if (action === 'end') await this.members.revokePendingInvitations(scope.tx, membershipId);
    await bumpScopeVersion(scope.tx, [membershipId]);
    await scope.emit({
      aggregateType: 'membership',
      aggregateId: membershipId,
      aggregateVersion: version,
      type: rule.event,
      schemaVersion: 1,
      payload: { membership_id: membershipId, type: member.membershipType, unit_id: member.organizationId },
      eventKey: `${rule.event}:${membershipId}:${version}`,
    });
    await scope.emit({
      aggregateType: 'membership',
      aggregateId: membershipId,
      aggregateVersion: version,
      type: 'iam.access.changed.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, membership_ids: [membershipId] },
      eventKey: `access-changed:${scope.requestId}`,
    });
    await scope.audit({
      action: `membership.${action}`,
      resourceType: 'membership',
      resourceId: membershipId,
      reason,
      diff: { from: member.status, to: rule.to },
    });
    return commandResult(scope, rule.label, version, membershipId);
  }
}
