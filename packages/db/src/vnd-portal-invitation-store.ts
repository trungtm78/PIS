import { randomUUID } from 'node:crypto';
import {
  DomainError,
  plusDays,
  assertContactProof,
  assertInvitable,
  assertSecondPerson,
  effectiveInvitationStatus,
  nextInvitationStatus,
  normaliseContactEmail,
  versionConflict,
  vietnamDateOf,
} from '@machvon/kernel';
import type { ContactBasis, PortalAccessPolicy, PortalInvitationStatus } from '@machvon/kernel';
import { BidContractorStore } from './bid-contractor-store.ts';
import { timestampKey } from './keyset.ts';
import type { TenantTx } from './tenant-database.ts';
import { VendorPortalPolicyReader } from './vnd3-portal-policy.ts';
import type { Policy } from './vendor-policy.ts';

const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";
const UNIQUE_VIOLATION = '23505';

export interface PortalInvitationRow {
  id: string;
  contractorId: string;
  contractorName: string;
  taxIdentifier: string;
  contactEmail: string;
  contactName: string;
  contactBasis: ContactBasis;
  basisReference: string | null;
  status: PortalInvitationStatus;
  effectiveStatus: PortalInvitationStatus;
  unitId: string;
  proposedBy: string;
  proposedAt: string;
  proposalExpiresAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  membershipId: string | null;
  accessValidUntil: string | null;
  revokedBy: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
  version: number;
}

interface Sql {
  id: string;
  contractor_id: string;
  contractor_name: string;
  tax_identifier: string;
  contact_email: string;
  contact_name: string;
  contact_basis: ContactBasis;
  basis_reference: string | null;
  status: PortalInvitationStatus;
  unit_id: string;
  proposed_by: string;
  proposed_at: string;
  proposal_expires_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  membership_id: string | null;
  access_valid_until: string | null;
  revoked_by: string | null;
  revoked_at: string | null;
  revoke_reason: string | null;
  version: string;
}

const SELECT = `select i.id, i.contractor_id, c.legal_name as contractor_name, i.tax_identifier, i.contact_email, i.contact_name, i.contact_basis, i.basis_reference, i.status, i.unit_id, i.proposed_by,
       ${timestampKey('i.proposed_at')} as proposed_at, ${timestampKey('i.proposal_expires_at')} as proposal_expires_at, i.decided_by, ${timestampKey('i.decided_at')} as decided_at, i.decision_note, i.membership_id,
       ${timestampKey('i.access_valid_until')} as access_valid_until, i.revoked_by, ${timestampKey('i.revoked_at')} as revoked_at, i.revoke_reason, i.version
  from machvon.contractor_portal_invitation i join machvon.contractor c on c.tenant_id = i.tenant_id and c.id = i.contractor_id`;

const END_MEMBERSHIP_SQL = `update machvon.membership set status = 'Ended', version = version + 1, ended_reason = $2 where id = $1::uuid and status in ('Invited', 'Active', 'Suspended')`;
const END_GRANTS_SQL = `update machvon.role_grant set status = 'Revoked', revoked_by = $2::uuid, revoked_at = $3::timestamptz, version = version + 1 where membership_id = $1::uuid and status = 'Active'`;

/** What the controller needs to create the invited guest: the invitation, the day the access ends, and the unit the guest belongs to. */
export type AccountCreator = (invitation: PortalInvitationRow, validUntil: Date) => Promise<string>;

/**
 * Access of a contractor to the portal through the contractor registry (PORTAL-2; docs/plans/portal2.md). ADM-17 invites a guest through contracts; here the invitation is bound to the REGISTRY ENTRY. One person proposes
 * a contact of a verified, unrestricted contractor with the proof that the contact is the contractor's; a different person approves (the two-person rule is also a CHECK of the table); the proposal and the access expire by
 * the rule `VENDOR_PORTAL_ACCESS`; a revocation ends the access at once with a reason. The store keeps the rows and the rules; the controller creates the invited guest through the creator callback, inside the same transaction.
 */
export class VendorPortalInvitationStore {
  private readonly policies: VendorPortalPolicyReader;
  private readonly contractors = new BidContractorStore();

  constructor(policies: VendorPortalPolicyReader = new VendorPortalPolicyReader()) {
    this.policies = policies;
  }

  policy(tx: TenantTx, today: string): Promise<Policy<PortalAccessPolicy>> {
    return this.policies.access(tx, today);
  }

  private rowOf(row: Sql, now: Date): PortalInvitationRow {
    return {
      id: row.id,
      contractorId: row.contractor_id,
      contractorName: row.contractor_name,
      taxIdentifier: row.tax_identifier,
      contactEmail: row.contact_email,
      contactName: row.contact_name,
      contactBasis: row.contact_basis,
      basisReference: row.basis_reference,
      status: row.status,
      effectiveStatus: effectiveInvitationStatus({ status: row.status, proposalExpiresAt: row.proposal_expires_at, accessValidUntil: row.access_valid_until, now }),
      unitId: row.unit_id,
      proposedBy: row.proposed_by,
      proposedAt: row.proposed_at,
      proposalExpiresAt: row.proposal_expires_at,
      decidedBy: row.decided_by,
      decidedAt: row.decided_at,
      decisionNote: row.decision_note,
      membershipId: row.membership_id,
      accessValidUntil: row.access_valid_until,
      revokedBy: row.revoked_by,
      revokedAt: row.revoked_at,
      revokeReason: row.revoke_reason,
      version: Number(row.version),
    };
  }

  async find(tx: TenantTx, id: string, now: Date, lock = false): Promise<PortalInvitationRow | undefined> {
    const rows = await tx.query<Sql>(`${SELECT} where i.id = $1::uuid${lock ? ' for update of i' : ''}`, [id]);
    return rows[0] === undefined ? undefined : this.rowOf(rows[0], now);
  }

  async list(tx: TenantTx, filter: { status?: string | undefined; contractorId?: string | undefined; limit?: number | undefined }, now: Date): Promise<PortalInvitationRow[]> {
    const rows = await tx.query<Sql>(`${SELECT} where ($1::text is null or i.status = $1) and ($2::uuid is null or i.contractor_id = $2::uuid) order by i.proposed_at desc, i.id limit $3`, [filter.status ?? null, filter.contractorId ?? null, filter.limit ?? 300]);
    return rows.map((row) => this.rowOf(row, now));
  }

  /** The live accounts of a contractor: invitations not yet decided or approved and not past their end, which count against `max_live_accounts`. */
  private async liveCount(tx: TenantTx, contractorId: string, now: Date, exceptId?: string): Promise<number> {
    const [row] = await tx.query<{ n: number }>(
      `select count(*)::int as n from machvon.contractor_portal_invitation
        where contractor_id = $1::uuid and ($3::uuid is null or id <> $3::uuid)
          and ((status = 'PROPOSED' and proposal_expires_at > $2::timestamptz) or (status = 'APPROVED' and access_valid_until > $2::timestamptz))`,
      [contractorId, now.toISOString(), exceptId ?? null],
    );
    return row?.n ?? 0;
  }

  /** Locks the contractor row first: two proposals or approvals for one contractor are counted one after the other, so the limit of accounts holds under concurrency. */
  private async checkContractor(tx: TenantTx, contractorId: string, now: Date): Promise<{ taxIdentifier: string; email: string | null }> {
    const contractor = await this.contractors.find(tx, contractorId, true);
    if (contractor === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const restricted = (await this.contractors.restrictionsInForce(tx, [contractorId], vietnamDateOf(now))).get(contractorId) !== undefined;
    assertInvitable({ verificationStatus: contractor.verificationStatus, restricted });
    const profile = await tx.query<{ email: string | null }>('select email from machvon.contractor where id = $1::uuid', [contractorId]);
    return { taxIdentifier: contractor.taxIdentifier, email: profile[0]?.email ?? null };
  }

  /** Proposes a contact of a contractor. 404 for an unknown contractor, 422 `CONTRACTOR_NOT_INVITABLE`, `PORTAL_CONTACT_UNPROVEN`, `PORTAL_ACCESS_LIMIT`, 409 `PORTAL_INVITATION_EXISTS`. */
  async propose(tx: TenantTx, input: { contractorId: string; contactEmail: string; contactName: string; contactBasis: string; basisReference?: string | undefined }, actor: string, now: Date): Promise<PortalInvitationRow> {
    const today = vietnamDateOf(now);
    const policy = (await this.policy(tx, today)).value;
    const standing = await this.checkContractor(tx, input.contractorId, now);
    const email = normaliseContactEmail(input.contactEmail);
    const name = input.contactName.trim();
    if (name.length < 2 || name.length > 200) throw new DomainError('VALIDATION_FAILED', 422, 'contact_name');
    const proof = assertContactProof({ basis: input.contactBasis, reference: input.basisReference, email, registryEmail: standing.email });
    const unit = (await tx.query<{ organization_id: string }>('select organization_id from machvon.membership where id = $1::uuid', [actor]))[0];
    if (unit === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    // A proposal nobody approved in time no longer blocks the same contact.
    await tx.query(`update machvon.contractor_portal_invitation set status = 'EXPIRED', expired_at = $3::timestamptz, version = version + 1 where contractor_id = $1::uuid and contact_email = $2 and status = 'PROPOSED' and proposal_expires_at <= $3::timestamptz`, [input.contractorId, email, now.toISOString()]);
    if ((await this.liveCount(tx, input.contractorId, now)) >= policy.max_live_accounts) throw new DomainError('PORTAL_ACCESS_LIMIT', 422, 'contractor_id', { extensions: { max_live_accounts: policy.max_live_accounts } });
    const id = randomUUID();
    try {
      await tx.query(
        `insert into machvon.contractor_portal_invitation (tenant_id, id, contractor_id, tax_identifier, contact_email, contact_name, contact_basis, basis_reference, status, unit_id, proposed_by, proposed_at, proposal_expires_at)
         values (${TENANT}, $1::uuid, $2::uuid, $3, $4, $5, $6, $7, 'PROPOSED', $8::uuid, $9::uuid, $10::timestamptz, $11::timestamptz)`,
        [id, input.contractorId, standing.taxIdentifier, email, name, proof.basis, proof.reference, unit.organization_id, actor, now.toISOString(), plusDays(now, policy.proposal_days).toISOString()],
      );
    } catch (error) {
      if (typeof error === 'object' && error !== null && (error as { code?: string }).code === UNIQUE_VIOLATION) throw new DomainError('PORTAL_INVITATION_EXISTS', 409, 'contact_email');
      throw error;
    }
    return (await this.find(tx, id, now)) as PortalInvitationRow;
  }

  private async lock(tx: TenantTx, id: string, expectedVersion: number, now: Date): Promise<PortalInvitationRow> {
    const held = await this.find(tx, id, now, true);
    if (held === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (held.version !== expectedVersion) throw versionConflict(held.version);
    return held;
  }

  /** Approves a proposal: a different person than the proposer, before it expires, for a contractor that is still invitable and under the account limit. The creator makes the invited guest and returns its membership id. */
  async approve(tx: TenantTx, id: string, expectedVersion: number, actor: string, note: string | undefined, now: Date, createAccount: AccountCreator): Promise<PortalInvitationRow> {
    const held = await this.lock(tx, id, expectedVersion, now);
    if (held.effectiveStatus === 'EXPIRED' && held.status === 'PROPOSED') throw new DomainError('PORTAL_INVITATION_STATE_INVALID', 409, 'status', { extensions: { invitation_status: 'EXPIRED' } });
    nextInvitationStatus(held.status, 'APPROVE');
    assertSecondPerson(held.proposedBy, actor);
    const policy = (await this.policy(tx, vietnamDateOf(now))).value;
    await this.checkContractor(tx, held.contractorId, now);
    if ((await this.liveCount(tx, held.contractorId, now, held.id)) >= policy.max_live_accounts) throw new DomainError('PORTAL_ACCESS_LIMIT', 422, 'contractor_id', { extensions: { max_live_accounts: policy.max_live_accounts } });
    const validUntil = plusDays(now, policy.access_days);
    const membershipId = await createAccount(held, validUntil);
    const cleanNote = note === undefined || note.trim() === '' ? null : note.trim();
    if (cleanNote !== null && (cleanNote.length < 5 || cleanNote.length > 1000)) throw new DomainError('VALIDATION_FAILED', 422, 'note');
    await tx.query(
      `update machvon.contractor_portal_invitation set status = 'APPROVED', decided_by = $2::uuid, decided_at = $3::timestamptz, decision_note = $4, membership_id = $5::uuid, access_valid_until = $6::timestamptz, version = version + 1 where id = $1::uuid`,
      [id, actor, now.toISOString(), cleanNote, membershipId, validUntil.toISOString()],
    );
    return (await this.find(tx, id, now)) as PortalInvitationRow;
  }

  async reject(tx: TenantTx, id: string, expectedVersion: number, actor: string, reason: string, now: Date): Promise<PortalInvitationRow> {
    const held = await this.lock(tx, id, expectedVersion, now);
    nextInvitationStatus(held.status, 'REJECT', reason);
    assertSecondPerson(held.proposedBy, actor);
    await tx.query(`update machvon.contractor_portal_invitation set status = 'REJECTED', decided_by = $2::uuid, decided_at = $3::timestamptz, decision_note = $4, version = version + 1 where id = $1::uuid`, [id, actor, now.toISOString(), reason.trim()]);
    return (await this.find(tx, id, now)) as PortalInvitationRow;
  }

  /** Revokes a proposal (it is withdrawn) or an approved access (the guest membership ends and its grants are revoked at once). Anyone with the right may revoke, the proposer too. */
  async revoke(tx: TenantTx, id: string, expectedVersion: number, actor: string, reason: string, now: Date): Promise<PortalInvitationRow> {
    const held = await this.lock(tx, id, expectedVersion, now);
    nextInvitationStatus(held.status, 'REVOKE', reason);
    await tx.query(
      `update machvon.contractor_portal_invitation set status = 'REVOKED', revoked_by = $2::uuid, revoked_at = $3::timestamptz, revoke_reason = $4, version = version + 1 where id = $1::uuid`,
      [id, actor, now.toISOString(), reason.trim()],
    );
    if (held.membershipId !== null) await this.endAccess(tx, held.membershipId, actor, now, 'portal invitation revoked');
    return (await this.find(tx, id, now)) as PortalInvitationRow;
  }

  private async endAccess(tx: TenantTx, membershipId: string, actor: string | null, now: Date, reason: string): Promise<void> {
    await tx.query(END_GRANTS_SQL, [membershipId, actor, now.toISOString()]);
    await tx.query(END_MEMBERSHIP_SQL, [membershipId, reason]);
  }

  /** The nightly job: proposals past their expiry and approved accesses past their end become EXPIRED, and the guest of an expired access is ended. Returns the counts. */
  async expireDue(tx: TenantTx, now: Date): Promise<{ proposals: number; accesses: number }> {
    const proposals = await tx.query<{ id: string }>(
      `update machvon.contractor_portal_invitation set status = 'EXPIRED', expired_at = $1::timestamptz, version = version + 1 where status = 'PROPOSED' and proposal_expires_at <= $1::timestamptz returning id`,
      [now.toISOString()],
    );
    const accesses = await tx.query<{ id: string; membership_id: string }>(
      `update machvon.contractor_portal_invitation set status = 'EXPIRED', expired_at = $1::timestamptz, version = version + 1 where status = 'APPROVED' and access_valid_until <= $1::timestamptz returning id, membership_id`,
      [now.toISOString()],
    );
    for (const row of accesses) await this.endAccess(tx, row.membership_id, null, now, 'portal access expired');
    return { proposals: proposals.length, accesses: accesses.length };
  }
}
