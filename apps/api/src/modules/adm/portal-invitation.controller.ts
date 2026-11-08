import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { BidWorkflowReads, MemberStore, RoleStore, TenantDatabase, VendorPortalInvitationStore } from '@machvon/db';
import type { PortalInvitationRow } from '@machvon/db';
import { DomainError, PORTAL_INVITATION_STATUSES } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { PORTAL_CLASS, announcePortal } from '../bid/vendor-portal-view';
import { todayOf } from '../bid/vendor-view';
import { deliverInvitation, issueInvitation } from './invitation-delivery';
import type { IssuedInvitation } from './invitation-delivery';
import { INVITATION_MAILER } from './invitation-mailer';
import type { InvitationMailer } from './invitation-mailer';
import { holdsOnWholeTenant } from './tenant-authority';

const PORTAL_ROLE = 'PORTAL_CONTRACTOR';
const BASELINE_ROLE = 'MEMBER';
const EVENT = 'vnd.portal.invitation.changed.v1';
const RESOURCE = 'contractor_portal_invitation';

const needs = (access: EffectiveAccess, permission: string): void => {
  if (!holdsOnWholeTenant(access, permission)) throw new DomainError('SCOPE_DENIED', 403);
};

const word = (value: unknown, field: string, allowed: readonly string[]): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !allowed.includes(value)) throw new DomainError('VALIDATION_FAILED', 422, field);
  return value;
};

const uuid = (value: unknown, field: string): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new DomainError('VALIDATION_FAILED', 422, field);
  return value.toLowerCase();
};

/** One invitation as the staff read it: the e-mail is shown to staff (they must judge the proof) but never goes to an audit row or an event. */
export const invitationDto = (row: PortalInvitationRow, names: ReadonlyMap<string, string>, viewer: string, access: EffectiveAccess): Record<string, unknown> => {
  const nameOf = (id: string | null): string | null => (id === null ? null : (names.get(id) ?? null));
  const open = row.effectiveStatus === 'PROPOSED';
  const decidable = open && row.proposedBy !== viewer;
  return {
    id: row.id,
    contractor_id: row.contractorId,
    contractor_name: row.contractorName,
    tax_identifier: row.taxIdentifier,
    contact_email: row.contactEmail,
    contact_name: row.contactName,
    contact_basis: row.contactBasis,
    basis_reference: row.basisReference,
    status: row.status,
    effective_status: row.effectiveStatus,
    proposed_by_name: nameOf(row.proposedBy),
    proposed_at: row.proposedAt,
    proposal_expires_at: row.proposalExpiresAt,
    decided_by_name: nameOf(row.decidedBy),
    decided_at: row.decidedAt,
    decision_note: row.decisionNote,
    access_valid_until: row.accessValidUntil,
    revoked_at: row.revokedAt,
    revoke_reason: row.revokeReason,
    actions: {
      approve: decidable && holdsOnWholeTenant(access, PERMISSIONS.approveVendorPortalInvitation),
      reject: decidable && holdsOnWholeTenant(access, PERMISSIONS.rejectVendorPortalInvitation),
      revoke: (row.effectiveStatus === 'PROPOSED' || row.effectiveStatus === 'APPROVED') && holdsOnWholeTenant(access, PERMISSIONS.revokeVendorPortalInvitation),
    },
    version: row.version,
  };
};

/**
 * Access of a contractor to the portal through the registry, with no contract (PORTAL-2; docs/plans/portal2.md, docs/vendor-investigation.md section 14). One person proposes a contact of a verified contractor with the proof that
 * the contact is the contractor's; a different person approves, which creates the invited guest bound to the contractor, with the system role PORTAL_CONTRACTOR (the portal rights and nothing else) on the unit of the proposer,
 * and sends the invitation through the same mail path as ADM-17. Each command is judged on a grant over the whole tenant, writes its audit row (CONFIDENTIAL) and its outbox event in one transaction; neither carries the e-mail.
 */
@Controller()
export class PortalInvitationController {
  private readonly invitations = new VendorPortalInvitationStore();
  private readonly roles = new RoleStore();
  private readonly members = new MemberStore();

  constructor(@Inject(INVITATION_MAILER) private readonly mailer: InvitationMailer) {}

  private version(scope: CommandScope): number {
    return scope.expectedVersion ?? 0;
  }

  @Post('vendor/portal/invitations')
  @HttpCode(200)
  @OperationId('proposeVendorPortalInvitation')
  @Command({ operation: 'proposeVendorPortalInvitation' })
  async propose(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['PortalInvitationNew']): Promise<CommandResult> {
    needs(access, PERMISSIONS.proposeVendorPortalInvitation);
    const now = new Date();
    const row = await this.invitations.propose(
      scope.tx,
      { contractorId: body.contractor_id, contactEmail: body.contact_email, contactName: body.contact_name, contactBasis: body.contact_basis, basisReference: body.basis_reference },
      scope.tenant.membershipId,
      now,
    );
    await announcePortal(scope, now, { action: 'vnd.portal_invitation_proposed', resourceType: RESOURCE, resourceId: row.id, classification: PORTAL_CLASS.answer, version: row.version, eventType: EVENT, diff: { contractor_id: row.contractorId, contact_basis: row.contactBasis, proposal_expires_at: row.proposalExpiresAt, status: row.status } });
    return commandResult(scope, 'PROPOSED', row.version, row.id);
  }

  @Post('vendor/portal/invitations/:id/approval')
  @HttpCode(200)
  @OperationId('approveVendorPortalInvitation')
  @Command({ operation: 'approveVendorPortalInvitation', versioned: true })
  async approve(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PortalInvitationApprove']): Promise<CommandResult> {
    needs(access, PERMISSIONS.approveVendorPortalInvitation);
    const now = new Date();
    let issued: IssuedInvitation | undefined;
    let unitId = '';
    const row = await this.invitations.approve(scope.tx, id, this.version(scope), scope.tenant.membershipId, body.note, now, async (invitation, validUntil) => {
      const role = await this.members.activeRoleByCode(scope.tx, PORTAL_ROLE);
      if (role === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'role');
      const unit = await this.members.unitOf(scope.tx, invitation.unitId);
      if (unit === undefined || unit.status !== 'Active') throw new DomainError('VALIDATION_FAILED', 422, 'unit_id');
      const resolved = await this.roles.resolveScope(scope.tx, 'UNIT_ONLY', [unit.id]);
      if (resolved === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'unit_id');
      await this.members.assertSeatFree(scope.tx, 'GUEST_CONTRACTOR');
      const userAccountId = await this.members.ensureInvitedAccount(scope.tx, invitation.contactEmail, invitation.contactName);
      const member = await this.members.insertInvitedMember(scope.tx, { userAccountId, organizationId: unit.id, membershipType: 'GUEST_CONTRACTOR', contractorId: invitation.contractorId, validUntil, invitedBy: scope.tenant.membershipId });
      const grant = { membershipId: member.id, scopeKind: 'UNIT_ONLY' as const, scopeRefIds: [unit.id], paths: resolved.paths, effectiveUntil: validUntil.toISOString(), grantedBy: scope.tenant.membershipId };
      await this.roles.insertGrant(scope.tx, { ...grant, roleId: role.id, reason: 'portal access approved through the contractor registry' });
      const baseline = await this.members.activeRoleByCode(scope.tx, BASELINE_ROLE);
      if (baseline !== undefined) await this.roles.insertGrant(scope.tx, { ...grant, roleId: baseline.id, reason: 'default role of the portal invitation' });
      issued = await issueInvitation(scope, this.members, { membershipId: member.id, email: invitation.contactEmail, now });
      unitId = unit.id;
      return member.id;
    });
    await announcePortal(scope, now, { action: 'vnd.portal_invitation_approved', resourceType: RESOURCE, resourceId: id, classification: PORTAL_CLASS.answer, version: row.version, eventType: EVENT, diff: { contractor_id: row.contractorId, membership_id: row.membershipId, access_valid_until: row.accessValidUntil, status: row.status } });
    await scope.emit({
      aggregateType: 'membership',
      aggregateId: row.membershipId ?? id,
      aggregateVersion: 1,
      type: 'iam.membership.invited.v1',
      schemaVersion: 1,
      payload: { membership_id: row.membershipId, type: 'GUEST_CONTRACTOR', unit_id: unitId },
      eventKey: `membership-invited:${row.membershipId ?? id}`,
    });
    // The token goes to the person only; the audit row and the events carry neither the e-mail nor the token.
    if (issued !== undefined) await deliverInvitation(this.mailer, scope, issued);
    return commandResult(scope, 'APPROVED', row.version, id);
  }

  @Post('vendor/portal/invitations/:id/rejection')
  @HttpCode(200)
  @OperationId('rejectVendorPortalInvitation')
  @Command({ operation: 'rejectVendorPortalInvitation', versioned: true })
  async reject(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PortalInvitationReason']): Promise<CommandResult> {
    needs(access, PERMISSIONS.rejectVendorPortalInvitation);
    const now = new Date();
    const row = await this.invitations.reject(scope.tx, id, this.version(scope), scope.tenant.membershipId, body.reason, now);
    await announcePortal(scope, now, { action: 'vnd.portal_invitation_rejected', resourceType: RESOURCE, resourceId: id, classification: PORTAL_CLASS.answer, version: row.version, eventType: EVENT, reason: body.reason, diff: { contractor_id: row.contractorId, status: row.status } });
    return commandResult(scope, 'REJECTED', row.version, id);
  }

  @Post('vendor/portal/invitations/:id/revocation')
  @HttpCode(200)
  @OperationId('revokeVendorPortalInvitation')
  @Command({ operation: 'revokeVendorPortalInvitation', versioned: true })
  async revoke(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PortalInvitationReason']): Promise<CommandResult> {
    needs(access, PERMISSIONS.revokeVendorPortalInvitation);
    const now = new Date();
    const row = await this.invitations.revoke(scope.tx, id, this.version(scope), scope.tenant.membershipId, body.reason, now);
    await announcePortal(scope, now, { action: 'vnd.portal_invitation_revoked', resourceType: RESOURCE, resourceId: id, classification: PORTAL_CLASS.answer, version: row.version, eventType: EVENT, reason: body.reason, diff: { contractor_id: row.contractorId, membership_id: row.membershipId, status: row.status } });
    return commandResult(scope, 'REVOKED', row.version, id);
  }
}

/** The staff read of the invitations (VND-23): the rows, the counts by status as of now, and the numbers of the rule with its version and legal status. */
@Controller()
export class PortalInvitationReadsController {
  private readonly invitations = new VendorPortalInvitationStore();
  private readonly people = new BidWorkflowReads();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('vendor/portal/invitations')
  @OperationId('listVendorPortalInvitations')
  async list(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    needs(access, PERMISSIONS.listVendorPortalInvitations);
    const status = word(query.status, 'status', PORTAL_INVITATION_STATUSES);
    const contractorId = uuid(query.contractor_id, 'contractor_id');
    const now = new Date();
    return this.database.withTenant(tenant, async (tx) => {
      const rows = await this.invitations.list(tx, { status, contractorId, limit: 300 }, now);
      const policy = await this.invitations.policy(tx, todayOf(now));
      const names = await this.people.names(tx, rows.flatMap((row) => [row.proposedBy, ...(row.decidedBy === null ? [] : [row.decidedBy])]));
      const count = (wanted: string): number => rows.filter((row) => row.effectiveStatus === wanted).length;
      return {
        items: rows.map((row) => invitationDto(row, names, tenant.membershipId, access)),
        counts: { proposed: count('PROPOSED'), approved: count('APPROVED'), expired: count('EXPIRED'), revoked: count('REVOKED') },
        policy: { ...policy.value, version: policy.version, unverified: policy.unverified },
        as_of: now.toISOString(),
      };
    });
  }
}
