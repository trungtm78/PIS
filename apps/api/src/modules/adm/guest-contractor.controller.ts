import { randomUUID } from 'node:crypto';
import { Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { MemberStore, RoleStore } from '@machvon/db';
import type { ResolvedScope } from '@machvon/db';
import { DomainError, activeGrants, holdsPermission, scopeCovers } from '@machvon/kernel';
import type { EffectiveAccess } from '@machvon/kernel';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import { Command, Scope } from '../../command.decorator';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { assertVerdict } from '../../iam-dto';
import { OperationId } from '../../operation-id.decorator';
import { authorise } from '../../role-grants.controller';
import { deliverInvitation, issueInvitation } from './invitation-delivery';
import { INVITATION_MAILER } from './invitation-mailer';
import type { InvitationMailer } from './invitation-mailer';

const GUEST_PERMISSION = PERMISSIONS.inviteGuestContractor;
const DAY_MS = 86_400_000;
const BASELINE_ROLE = 'MEMBER';

/**
 * How long a guest may stay after the latest end of their contracts (BR-IAM-08). The design says the access is bounded by
 * the contracts but gives no figure; one year is the assumption recorded in ADM.md (CR-ADM-07) until the business owner decides.
 */
export const GUEST_GRACE_DAYS = 365;

/**
 * Whether a grant of the caller that carries the permission to invite guests covers the contracts. The contracts are judged as
 * they are (a CONTRACT grant) and through their owner units (a unit grant): a unit subtree cannot be compared with a contract
 * scope, so either one is enough, whichever scope the right to grant the role was reached on.
 */
function mayInviteGuests(access: EffectiveAccess, resolved: ResolvedScope, now: Date): boolean {
  const targets = resolved.ownerUnitScope === undefined ? [resolved.scope] : [resolved.scope, resolved.ownerUnitScope];
  return activeGrants(access, now).some(
    (grant) => targets.some((target) => scopeCovers(grant.scope, target)) && grant.permissions.some((permission) => holdsPermission(new Set([permission]), GUEST_PERMISSION)),
  );
}

/**
 * Guest contractors (ADM-17, ST-ADM-007): invites a person of a contractor with one guest role scoped to contracts of that
 * contractor (BR-IAM-08). The caller must hold `iam.guest.invite` and `iam.role.grant` over the contracts (BR-IAM-05 applies to
 * the role), the contracts must be in force, and the access ends with a `valid_until` that is bounded by the contracts.
 */
@Controller('guest-memberships')
export class GuestContractorController {
  private readonly roles = new RoleStore();
  private readonly members = new MemberStore();

  constructor(@Inject(INVITATION_MAILER) private readonly mailer: InvitationMailer) {}

  @Post()
  @HttpCode(201)
  @OperationId('inviteGuestContractor')
  @Command({ operation: 'inviteGuestContractor' })
  async invite(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['GuestInvite']): Promise<CommandResult> {
    const now = new Date();
    const role = await this.roles.findRole(scope.tx, body.role_id);
    if (role === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (role.status !== 'Active') throw new DomainError('VALIDATION_FAILED', 422, 'role_id');
    if (!role.guestAllowed) throw new DomainError('GUEST_SCOPE_INVALID', 422);
    const contractIds = [...new Set(body.contract_ids)];
    const resolved = await this.roles.resolveScope(scope.tx, 'CONTRACT', contractIds);
    // The guest belongs to the unit that owns the first contract by id (ADM.md, inviteGuestContractor), not to the first unit by id.
    const firstContractId = [...contractIds].map((contractId) => contractId.toLowerCase()).sort()[0];
    const firstOwner = firstContractId === undefined ? undefined : (await this.roles.resolveScope(scope.tx, 'CONTRACT', [firstContractId]))?.ownerUnitScope;
    const ownerUnitId = firstOwner === undefined || firstOwner.kind === 'TENANT' ? undefined : firstOwner.refIds[0];
    if (resolved === undefined || ownerUnitId === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'contract_ids');

    // The recipient does not exist yet: a new id stands in for them, so only the self-grant rule is moot.
    const authorised = authorise(access, randomUUID(), role, resolved);
    assertVerdict(authorised.verdict);
    if (!mayInviteGuests(access, resolved, now)) throw new DomainError('SCOPE_DENIED', 403);
    // Checked after the caller's reach, so a caller outside their range learns nothing about the contracts of others.
    const issue = await this.roles.guestContractIssue(scope.tx, body.contractor_id, contractIds);
    if (issue === 'FOREIGN_CONTRACTOR') throw new DomainError('GUEST_SCOPE_INVALID', 422);
    if (issue === 'NOT_ACTIVE') throw new DomainError('CONTRACT_NOT_ACTIVE', 422);
    const unit = await this.members.unitOf(scope.tx, ownerUnitId);
    if (unit === undefined || unit.status !== 'Active') throw new DomainError('VALIDATION_FAILED', 422, 'contract_ids');
    const validUntil = await this.validUntilOf(scope, body.valid_until, contractIds, now);

    // As for staff: an invitation holds no seat, but a tenant with no guest seat free does not invite.
    await this.members.assertSeatFree(scope.tx, 'GUEST_CONTRACTOR');
    const userAccountId = await this.members.ensureInvitedAccount(scope.tx, body.email, undefined);
    const member = await this.members.insertInvitedMember(scope.tx, {
      userAccountId,
      organizationId: unit.id,
      membershipType: 'GUEST_CONTRACTOR',
      contractorId: body.contractor_id,
      validUntil,
      invitedBy: scope.tenant.membershipId,
    });
    await this.roles.insertGrant(scope.tx, {
      membershipId: member.id,
      roleId: role.id,
      scopeKind: 'CONTRACT',
      scopeRefIds: contractIds,
      paths: resolved.paths,
      effectiveUntil: validUntil.toISOString(),
      grantedBy: scope.tenant.membershipId,
      reason: 'initial grant of the guest invitation',
    });
    if (role.code !== BASELINE_ROLE) await this.grantBaseline(scope, member.id, contractIds, resolved, validUntil);
    const invitation = await issueInvitation(scope, this.members, { membershipId: member.id, email: body.email, now });
    await scope.emit({
      aggregateType: 'membership',
      aggregateId: member.id,
      aggregateVersion: 1,
      type: 'iam.membership.invited.v1',
      schemaVersion: 1,
      payload: { membership_id: member.id, type: 'GUEST_CONTRACTOR', unit_id: unit.id },
      eventKey: `membership-invited:${member.id}`,
    });
    // The audit row and the event carry no email and no token: the email is in the account, the token only goes to the person.
    await scope.audit({
      action: 'membership.guest_invited',
      resourceType: 'membership',
      resourceId: member.id,
      diff: {
        contractor_id: body.contractor_id,
        contract_ids: contractIds,
        role_code: role.code,
        valid_until: validUntil.toISOString(),
        expires_at: invitation.expiresAt.toISOString(),
      },
    });
    await deliverInvitation(this.mailer, scope, invitation);
    return commandResult(scope, 'INVITED', member.version, member.id);
  }

  /**
   * The self-service rights every member needs to sign in and read their own session (the MEMBER role, which guests may hold), on
   * the same contracts and for the same time as the role of the invitation. It is no privilege the inviter hands out, as for staff.
   */
  private async grantBaseline(scope: CommandScope, membershipId: string, contractIds: readonly string[], resolved: ResolvedScope, validUntil: Date): Promise<void> {
    const baseline = await this.members.activeRoleByCode(scope.tx, BASELINE_ROLE);
    if (baseline === undefined) return;
    await this.roles.insertGrant(scope.tx, {
      membershipId,
      roleId: baseline.id,
      scopeKind: 'CONTRACT',
      scopeRefIds: contractIds,
      paths: resolved.paths,
      effectiveUntil: validUntil.toISOString(),
      grantedBy: scope.tenant.membershipId,
      reason: 'default role of the guest invitation',
    });
  }

  /**
   * The end of the guest's access: in the future and at most `GUEST_GRACE_DAYS` after the latest end of the contracts
   * (counted from today when a contract has no end date or has ended already).
   */
  private async validUntilOf(scope: CommandScope, value: string, contractIds: readonly string[], now: Date): Promise<Date> {
    const validUntil = new Date(value);
    if (validUntil.getTime() <= now.getTime()) throw new DomainError('VALIDATION_FAILED', 422, 'valid_until');
    const end = await this.members.latestContractEnd(scope.tx, contractIds);
    const base = Math.max(end?.getTime() ?? 0, now.getTime());
    if (validUntil.getTime() > base + GUEST_GRACE_DAYS * DAY_MS) throw new DomainError('VALIDATION_FAILED', 422, 'valid_until');
    return validUntil;
  }
}
