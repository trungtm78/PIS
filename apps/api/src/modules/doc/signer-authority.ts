import { DoaMatrixStore, SignerAuthorityStore } from '@machvon/db';
import type { SigningMode, TenantTx } from '@machvon/db';
import { DomainError, permissionMatches } from '@machvon/kernel';

/** The permission a delegation must carry for its delegate to sign in the name of the delegator. */
const SIGN_PERMISSION = 'doc.outgoing.sign';

export interface SignerCheck {
  documentType: string;
  /** Whole VND declared by the document; null when it declares none (the band that holds 0 applies). */
  amountVnd: string | null;
  draftingUnitId: string;
  signerId: string;
  signingMode: SigningMode | string;
  delegationId: string | null;
  at: Date;
  /** The Vietnam date on which the matrix is read. */
  businessDate: string;
}

/** What made the signer authorised: the matrix version that decided and whether it was the signer's own role or a delegation. */
export interface SignerAuthorization {
  matrixVersionId: string;
  ruleId: string;
  approverRoleId: string;
  via: 'ROLE' | 'DELEGATION';
  delegationId: string | null;
}

const refused = (reason: string, extra: Record<string, unknown> = {}): DomainError =>
  new DomainError('SIGNER_NOT_AUTHORIZED', 422, 'signer_user_id', { extensions: { reason, ...extra } });

/**
 * BR-DOC-08: who may sign a document. The signer must be an active member, and the DoA matrix in force names the role that signs a
 * document of this type, amount and unit; the signer holds that role over the drafting unit, or signs by a delegation (KT., TM., TL.,
 * TUQ.) that is in force, was given to the signer, covers the unit and carries the sign permission, from a delegator who holds the role.
 * A refusal says why and shows the threshold that decided, so the screen can explain it.
 */
export class SignerAuthority {
  private readonly doa = new DoaMatrixStore();
  private readonly organisation = new SignerAuthorityStore();

  async authorise(tx: TenantTx, check: SignerCheck): Promise<SignerAuthorization> {
    if (!(await this.organisation.isActiveMember(tx, check.signerId, check.at))) throw refused('SIGNER_INACTIVE');
    let resolution;
    try {
      resolution = await this.doa.resolve(tx, { documentType: check.documentType, amountVnd: check.amountVnd, unitId: check.draftingUnitId, businessDate: check.businessDate });
    } catch (error) {
      if (error instanceof DomainError && error.code === 'DOA_RULE_NOT_FOUND') throw refused('DOA_RULE_NOT_FOUND', { threshold: { document_type: check.documentType, amount_vnd: check.amountVnd } });
      throw error;
    }
    const band = await this.organisation.band(tx, resolution.ruleId);
    const threshold = {
      document_type: check.documentType,
      amount_vnd: check.amountVnd,
      rule_id: resolution.ruleId,
      matrix_version_id: resolution.matrixVersionId,
      approver_role_id: resolution.approverRoleId,
      amount_min_vnd: band?.amountMinVnd ?? null,
      amount_max_vnd: band?.amountMaxVnd ?? null,
    };
    const outcome = (via: 'ROLE' | 'DELEGATION', delegationId: string | null): SignerAuthorization => ({
      matrixVersionId: resolution.matrixVersionId,
      ruleId: resolution.ruleId,
      approverRoleId: resolution.approverRoleId,
      via,
      delegationId,
    });
    const holdsRole = (membershipId: string): Promise<boolean> =>
      this.organisation.holdsRoleOnUnit(tx, { membershipId, roleId: resolution.approverRoleId, unitId: check.draftingUnitId, at: check.at });
    if (check.signingMode === 'DIRECT') {
      if (!(await holdsRole(check.signerId))) throw refused('ROLE_NOT_HELD', { threshold });
      return outcome('ROLE', null);
    }
    const delegation = await this.checkDelegation(tx, check, threshold);
    if (!(await holdsRole(delegation.delegatorMembershipId))) throw refused('DELEGATOR_NOT_AUTHORIZED', { threshold });
    return outcome('DELEGATION', delegation.id);
  }

  /**
   * The delegation alone, at the time of signing: the document was approved against the matrix then, and a running approval keeps it, but
   * a delegation lasts at most 90 days and may have ended or been revoked since.
   */
  async assertDelegation(tx: TenantTx, check: SignerCheck): Promise<void> {
    if (check.signingMode === 'DIRECT') return;
    await this.checkDelegation(tx, check, undefined);
  }

  /** The delegator behind a delegation, for the audit rows of a document signed under it (ADM-11: both identities); undefined without a delegation. */
  async delegatorOf(tx: TenantTx, delegationId: string | null): Promise<string | undefined> {
    if (delegationId === null) return undefined;
    const [row] = await tx.query<{ delegator_membership_id: string }>('select delegator_membership_id from machvon.delegation_grant where id = $1::uuid', [delegationId]);
    return row?.delegator_membership_id;
  }

  private async checkDelegation(tx: TenantTx, check: SignerCheck, threshold: Record<string, unknown> | undefined): Promise<{ id: string; delegatorMembershipId: string }> {
    const extra = threshold === undefined ? {} : { threshold };
    if (check.delegationId === null) throw refused('DELEGATION_MISSING', extra);
    const delegation = await this.organisation.delegation(tx, check.delegationId, check.draftingUnitId);
    if (delegation === undefined || delegation.delegateMembershipId !== check.signerId) throw refused('DELEGATION_INVALID', extra);
    const at = check.at.getTime();
    if (delegation.status === 'Revoked' || delegation.status === 'Ended' || at < delegation.validFrom.getTime() || at >= delegation.validUntil.getTime()) throw refused('DELEGATION_EXPIRED', extra);
    if (!delegation.permissions.some((pattern) => permissionMatches(pattern, SIGN_PERMISSION)) || !delegation.coversUnit) throw refused('DELEGATION_INVALID', extra);
    return { id: delegation.id, delegatorMembershipId: delegation.delegatorMembershipId };
  }
}
