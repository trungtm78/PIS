import { DomainError, GATE_CHECKS_BY_ACTION, gateSubjects, profileCoverage, qualificationFindings, vietnamDateOf } from '@machvon/kernel';
import type { GateAction, PayeeWarning, QualificationRequirement } from '@machvon/kernel';
import { BidContractorStore } from './bid-contractor-store.ts';
import type { TenantTx } from './tenant-database.ts';
import { VendorPayeeStore } from './vendor-payee-store.ts';
import { VendorPolicyReader } from './vendor-policy.ts';
import { VendorProfileStore, factsOfProfile } from './vendor-profile-store.ts';
import { VendorQualificationStore, heldOf } from './vendor-qualification-store.ts';
import { VendorVentureStore } from './vendor-venture-store.ts';

/** A condition the gate lets through with a warning: the policy softens it while the records are completed, or a payment goes to a contractor that never had an account. */
export interface GateWarning {
  code: 'PROFILE_INCOMPLETE' | 'QUALIFICATION_GAP' | PayeeWarning;
  detail: Record<string, unknown>;
}

export interface GateRequest {
  /** The contractor the action is about; for a payment it may be left out when `contractId` names the contract. */
  contractorId?: string | undefined;
  /** The contract: its parties are asked about too, its package gives the requirements of the certificates, its contractor is the payee. */
  contractId?: string | undefined;
  packageId?: string | undefined;
  /** The instant of the action: the waiting period of an account is counted against it. */
  now?: Date | undefined;
  /** The business day the dates of the restrictions and certificates are judged on, when the caller works on a day it was given (a payment names its own day); else the Vietnam day of `now`. */
  today?: string | undefined;
}

/**
 * The gates of the management of contractors (VND-1, V2 and V12): one precondition for the five places a contractor meets the law and the money, in the way `PayDisbursementCheck` is one for a disbursement. It is asked at the
 * submission of a bid, the result of a package, the activation of a contract, a subcontract and a payment, and answers by throwing the refusal or returning the warnings the policy allows. A restriction in force on the
 * contractor, on a member of a joint venture it leads or on a party of the contract always blocks (422 `CONTRACTOR_RESTRICTED`); an unverified tax code blocks (`CONTRACTOR_NOT_VERIFIED`); an incomplete profile (422
 * `CONTRACTOR_PROFILE_INCOMPLETE`) and a certificate that the package asks and the contractor lacks (422 `CONTRACTOR_QUALIFICATION_MISSING`) block or warn as the rule `VENDOR_GATE` says; a payment with no valid account is
 * blocked (422 `PAYEE_ACCOUNT_NOT_VALID`). The checks each action asks are `GATE_CHECKS_BY_ACTION`.
 */
export class VendorGate {
  private readonly contractors = new BidContractorStore();
  private readonly profiles = new VendorProfileStore();
  private readonly qualifications = new VendorQualificationStore();
  private readonly ventures = new VendorVentureStore();
  private readonly policies: VendorPolicyReader;
  private readonly payee: VendorPayeeStore;

  constructor(policies: VendorPolicyReader = new VendorPolicyReader()) {
    this.policies = policies;
    this.payee = new VendorPayeeStore(undefined, policies);
  }

  async assertAllowed(tx: TenantTx, action: GateAction, request: GateRequest): Promise<GateWarning[]> {
    const now = request.now ?? new Date();
    const today = request.today ?? vietnamDateOf(now);
    const checks = GATE_CHECKS_BY_ACTION[action];
    let contractorId = request.contractorId;
    let packageId = request.packageId;
    let parties: string[] = [];
    if (request.contractId !== undefined) {
      const [contract] = await tx.query<{ contractor_id: string; package_id: string }>('select contractor_id, package_id from machvon.contract where id = $1::uuid', [request.contractId]);
      if (contract === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'contract_id');
      contractorId ??= contract.contractor_id;
      packageId ??= contract.package_id;
      const rows = await tx.query<{ contractor_id: string }>('select contractor_id from machvon.contract_party where contract_id = $1::uuid', [request.contractId]);
      parties = rows.map((row) => row.contractor_id);
    }
    if (contractorId === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'contractor_id');
    const warnings: GateWarning[] = [];

    if (checks.includes('RESTRICTION')) {
      const ventureMembers = await this.ventures.membersLedBy(tx, contractorId, packageId);
      const subjects = gateSubjects(contractorId, ventureMembers, parties);
      const found = await this.contractors.restrictionsInForce(tx, subjects, today);
      const hit = subjects.find((id) => found.has(id));
      if (hit !== undefined) {
        const restriction = found.get(hit);
        throw new DomainError('CONTRACTOR_RESTRICTED', 422, undefined, {
          extensions: {
            restriction: { kind: restriction?.kind, effective_from: restriction?.effectiveFrom, effective_until: restriction?.effectiveUntil },
            restricted_contractor_id: hit,
            via: hit === contractorId ? 'SELF' : ventureMembers.includes(hit) ? 'JOINT_VENTURE_MEMBER' : 'CONTRACT_PARTY',
            action,
          },
        });
      }
    }

    if (checks.includes('VERIFICATION')) {
      const row = await this.contractors.find(tx, contractorId);
      if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      if (row.verificationStatus !== 'VERIFIED') throw new DomainError('CONTRACTOR_NOT_VERIFIED', 422);
    }

    const gate = checks.includes('PROFILE') || checks.includes('QUALIFICATION') ? (await this.policies.gate(tx, today)).value : undefined;

    if (checks.includes('PROFILE') && gate !== undefined) {
      const profile = await this.profiles.require(tx, contractorId);
      const required = (await this.policies.profile(tx, today)).value.required_before_bid;
      const coverage = profileCoverage(factsOfProfile(profile), required);
      if (!coverage.complete) {
        if (gate.profile_enforcement === 'BLOCK') throw new DomainError('CONTRACTOR_PROFILE_INCOMPLETE', 422, undefined, { extensions: { missing: coverage.missing, coverage_pct: coverage.coveragePct, action } });
        warnings.push({ code: 'PROFILE_INCOMPLETE', detail: { missing: coverage.missing, coverage_pct: coverage.coveragePct } });
      }
    }

    if (checks.includes('QUALIFICATION') && gate !== undefined && packageId !== undefined) {
      const requirements = (await this.qualifications.requirements(tx, packageId)).map((row): QualificationRequirement => ({ kind: row.kind, minGrade: row.minGrade, scopeKeyword: row.scopeKeyword }));
      if (requirements.length > 0) {
        const expiry = (await this.policies.expiry(tx, 'QUALIFICATION', today)).value;
        const held = (await this.qualifications.qualifications(tx, contractorId)).map(heldOf);
        const findings = qualificationFindings(requirements, held, today, expiry);
        if (findings.length > 0) {
          const detail = { package_id: packageId, findings: findings.map((finding) => ({ kind: finding.kind, gap: finding.gap, qualification_id: finding.qualificationId })) };
          if (gate.qualification_enforcement === 'BLOCK') throw new DomainError('CONTRACTOR_QUALIFICATION_MISSING', 422, undefined, { extensions: { ...detail, action } });
          warnings.push({ code: 'QUALIFICATION_GAP', detail });
        }
      }
    }

    if (checks.includes('PAYEE')) {
      const { verdict } = await this.payee.verdict(tx, contractorId, now);
      if (!verdict.allowed) throw new DomainError('PAYEE_ACCOUNT_NOT_VALID', 422, 'contractor_id', { extensions: { reason: verdict.reason, valid_from: verdict.validFrom, contractor_id: contractorId } });
      for (const warning of verdict.warnings) warnings.push({ code: warning, detail: { contractor_id: contractorId } });
    }
    return warnings;
  }
}
