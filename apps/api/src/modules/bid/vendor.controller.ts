import { Body, Controller, HttpCode, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { RestrictionCaseStore, VendorPayeeStore, VendorPolicyReader, VendorProfileStore, VendorQualificationStore, VendorReputationStore, VendorVentureStore } from '@machvon/db';
import type { CaseRow } from '@machvon/db';
import { DomainError } from '@machvon/kernel';
import type { FieldCipher, QualificationGrade, QualificationKind, RestrictionScope, RestrictionTrigger, StaffRole } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import type { EffectiveAccess } from '@machvon/kernel';
import { OperationId } from '../../operation-id.decorator';
import { holdsOnWholeTenant } from '../adm/tenant-authority';
import { duplicateDto, policyDto, todayOf } from './vendor-view';
import { VENDOR_CIPHER } from './tokens';

const CLASS = { profile: 'PERSONAL', bank: 'PERSONAL', caseRecord: 'CONFIDENTIAL', plain: 'INTERNAL' } as const;
type Classification = (typeof CLASS)[keyof typeof CLASS];

interface Announcement {
  action: string;
  resourceType: string;
  resourceId: string;
  classification: Classification;
  version: number;
  eventType: string;
  reason?: string | undefined;
  diff: Record<string, unknown>;
  payload?: Record<string, unknown>;
}

/** Writes the audit row (ADM-11) and the outbox event of a command; the payload carries ids and codes only, never the words of a person and never an account number. */
async function announce(scope: CommandScope, now: Date, item: Announcement): Promise<void> {
  await scope.audit({ action: item.action, resourceType: item.resourceType, resourceId: item.resourceId, classification: item.classification, ...(item.reason === undefined ? {} : { reason: item.reason }), diff: item.diff });
  await scope.emit({
    aggregateType: item.resourceType,
    aggregateId: item.resourceId,
    aggregateVersion: item.version,
    type: item.eventType,
    schemaVersion: 1,
    payload: { tenant_id: scope.tenant.tenantId, resource_id: item.resourceId, version: item.version, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString(), action: item.action, ...(item.payload ?? {}), ...item.diff },
    eventKey: `${item.resourceType}:${item.resourceId}:${item.version}:${item.action}`,
  });
}

const only = (value: string | undefined): string | undefined => (value === undefined || value === '' ? undefined : value);

/**
 * The commands of the management of contractors (VND-02 to VND-06, docs/vendor-management.md). Each runs in one transaction with its audit row and its outbox event, judged by the kernel rules and the governance rules
 * (no threshold lives here). The register belongs to the whole tenant, so every command needs its permission through a grant on the whole tenant. The persons are never trusted from the body: the actor is the caller,
 * and the separation of duties (the proposer of a ban, the requester of a change of account, the recorder of an event, the enterer of a certificate) is enforced by the stores and again by the database.
 */
@Controller()
export class VendorController {
  private readonly profiles = new VendorProfileStore();
  private readonly qualifications = new VendorQualificationStore();
  private readonly cases = new RestrictionCaseStore();
  private readonly ventures = new VendorVentureStore();
  private readonly reputation = new VendorReputationStore();
  private readonly policies = new VendorPolicyReader();
  private readonly payee: VendorPayeeStore;

  constructor(@Inject(VENDOR_CIPHER) private readonly cipher: FieldCipher) {
    this.payee = new VendorPayeeStore(cipher);
  }

  private require(access: EffectiveAccess, permission: string): void {
    if (!holdsOnWholeTenant(access, permission)) throw new DomainError('SCOPE_DENIED', 403);
  }

  private version(scope: CommandScope): number {
    return scope.expectedVersion ?? 0;
  }

  // -- Profile and owners -------------------------------------------------------------------------------------------------------------------------------------------------------------

  @Post('vendor/contractors/:id/profile')
  @HttpCode(200)
  @OperationId('updateVendorProfile')
  @Command({ operation: 'updateVendorProfile', versioned: true })
  async updateProfile(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['VendorProfileUpdate']): Promise<CommandResult> {
    this.require(access, PERMISSIONS.updateVendorProfile);
    const now = new Date();
    const today = todayOf(now);
    const policy = await this.policies.profile(scope.tx, today);
    const row = await this.profiles.update(
      scope.tx,
      id,
      this.version(scope),
      { legalRepName: body.legal_rep_name, legalRepPosition: body.legal_rep_position, registeredAddress: body.registered_address, phone: body.phone, email: body.email, businessRegistrationNo: body.business_registration_no },
      scope.tenant.membershipId,
      today,
      policy.value.review_months,
    );
    // A change of an address, a number or a representative may make the contractor one party with another: the suggestions are looked for again (a hint for a person, never a merge).
    await this.profiles.scan(scope.tx, id, (await this.policies.duplicateWeights(scope.tx, today)).value);
    const fields = Object.keys(body).filter((key) => (body as Record<string, unknown>)[key] !== undefined);
    await announce(scope, now, { action: 'vnd.profile_updated', resourceType: 'contractor', resourceId: id, classification: CLASS.profile, version: row.version, eventType: 'vnd.profile.updated.v1', diff: { contractor_id: id, fields, policy_version: policy.version } });
    return commandResult(scope, 'UPDATED', row.version, id);
  }

  @Post('vendor/contractors/:id/ownership-declaration')
  @HttpCode(200)
  @OperationId('declareVendorNoOwnerAboveThreshold')
  @Command({ operation: 'declareVendorNoOwnerAboveThreshold', versioned: true })
  async declareOwnership(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    this.require(access, PERMISSIONS.declareVendorNoOwnerAboveThreshold);
    const row = await this.profiles.declareNoOwnerAboveThreshold(scope.tx, id, this.version(scope), scope.tenant.membershipId);
    await announce(scope, new Date(), { action: 'vnd.ownership_declared', resourceType: 'contractor', resourceId: id, classification: CLASS.profile, version: row.version, eventType: 'vnd.owner.changed.v1', diff: { contractor_id: id, declaration: 'NO_OWNER_ABOVE_THRESHOLD' } });
    return commandResult(scope, 'DECLARED', row.version, id);
  }

  @Post('vendor/contractors/:id/owners')
  @HttpCode(200)
  @OperationId('addVendorOwner')
  @Command({ operation: 'addVendorOwner' })
  async addOwner(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['VendorOwnerNew']): Promise<CommandResult> {
    this.require(access, PERMISSIONS.addVendorOwner);
    const tenantId = scope.tenant.tenantId;
    const owner = await this.profiles.addOwner(
      scope.tx,
      id,
      { ownerKind: body.owner_kind, ownerName: body.owner_name, identityNumber: only(body.identity_number), sharePct: only(body.share_pct), beneficialOwner: body.beneficial_owner, controlBasis: body.control_basis, sourceDocumentId: only(body.source_document_id) },
      scope.tenant.membershipId,
      (value) => this.cipher.blindIndex(tenantId, 'owner-identity', value),
    );
    await announce(scope, new Date(), { action: 'vnd.owner_added', resourceType: 'contractor_owner', resourceId: owner.id, classification: CLASS.profile, version: owner.version, eventType: 'vnd.owner.changed.v1', diff: { contractor_id: id, owner_kind: owner.ownerKind, beneficial_owner: owner.beneficialOwner, share_pct: owner.sharePct } });
    return commandResult(scope, 'CREATED', owner.version, owner.id);
  }

  @Post('vendor/owners/:id/end')
  @HttpCode(200)
  @OperationId('endVendorOwner')
  @Command({ operation: 'endVendorOwner' })
  async endOwner(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) ownerId: string, @Body() body: Schemas['VendorReason']): Promise<CommandResult> {
    this.require(access, PERMISSIONS.endVendorOwner);
    const now = new Date();
    const owner = await this.profiles.endOwner(scope.tx, ownerId, body.reason, scope.tenant.membershipId, todayOf(now));
    await announce(scope, now, { action: 'vnd.owner_ended', resourceType: 'contractor_owner', resourceId: ownerId, classification: CLASS.profile, version: owner.version, eventType: 'vnd.owner.changed.v1', reason: body.reason, diff: { contractor_id: owner.contractorId, ended_on: owner.endedOn } });
    return commandResult(scope, 'ENDED', owner.version, ownerId);
  }

  @Post('vendor/contractors/:id/duplicate-scan')
  @HttpCode(200)
  @OperationId('scanVendorDuplicates')
  @Command({ operation: 'scanVendorDuplicates' })
  async scanDuplicates(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    this.require(access, PERMISSIONS.scanVendorDuplicates);
    const now = new Date();
    await this.profiles.require(scope.tx, id);
    const policy = await this.policies.duplicateWeights(scope.tx, todayOf(now));
    const found = await this.profiles.scan(scope.tx, id, policy.value);
    await scope.audit({ action: 'vnd.duplicates_scanned', resourceType: 'contractor', resourceId: id, classification: CLASS.plain, diff: { contractor_id: id, open_suggestions: found.length, policy_version: policy.version } });
    return { items: found.map(duplicateDto), policy: policyDto('VENDOR_DUPLICATE_SIGNALS', policy), as_of: now.toISOString() };
  }

  @Post('vendor/duplicates/:id/decision')
  @HttpCode(200)
  @OperationId('decideVendorDuplicate')
  @Command({ operation: 'decideVendorDuplicate', versioned: true })
  async decideDuplicate(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['VendorDuplicateDecision']): Promise<CommandResult> {
    this.require(access, PERMISSIONS.decideVendorDuplicate);
    const row = await this.profiles.decideSuggestion(scope.tx, id, this.version(scope), body.decision, body.reason, scope.tenant.membershipId);
    // The merge itself is the work of master data (MDM F5): the event is the hook its consumer reads.
    await announce(scope, new Date(), {
      action: 'vnd.duplicate_decided',
      resourceType: 'contractor_duplicate_suggestion',
      resourceId: id,
      classification: CLASS.plain,
      version: row.version,
      eventType: 'vnd.duplicate.decided.v1',
      reason: body.reason,
      diff: { decision: body.decision, contractor_a_id: row.contractorAId, contractor_b_id: row.contractorBId, score: row.score, signals: row.signals },
    });
    return commandResult(scope, body.decision, row.version, id);
  }

  // -- Accounts -----------------------------------------------------------------------------------------------------------------------------------------------------------------------

  private async bankEvent(scope: CommandScope, now: Date, action: string, requestId: string, contractorId: string, version: number, extra: Record<string, unknown> = {}, reason?: string): Promise<void> {
    await announce(scope, now, { action, resourceType: 'contractor_bank_change_request', resourceId: requestId, classification: CLASS.bank, version, eventType: 'vnd.bank.changed.v1', reason, diff: { contractor_id: contractorId, ...extra } });
  }

  @Post('vendor/contractors/:id/payee-changes')
  @HttpCode(200)
  @OperationId('requestVendorPayeeChange')
  @Command({ operation: 'requestVendorPayeeChange' })
  async requestChange(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['VendorPayeeChangeNew']): Promise<CommandResult> {
    this.require(access, PERMISSIONS.requestVendorPayeeChange);
    const now = new Date();
    const row = await this.payee.request(scope.tx, id, { bankName: body.bank_name, accountHolder: body.account_holder, accountNumber: body.account_number, reason: body.reason, evidenceDocumentId: body.evidence_document_id }, scope.tenant.membershipId, now);
    await this.bankEvent(scope, now, 'vnd.bank_change_requested', row.id, id, row.version, { account_no_masked: row.accountNoMasked, holder_matches_legal_name: row.holderMatchesLegalName }, row.reason);
    return commandResult(scope, 'REQUESTED', row.version, row.id);
  }

  @Post('vendor/payee-changes/:id/approval')
  @HttpCode(200)
  @OperationId('approveVendorPayeeChange')
  @Command({ operation: 'approveVendorPayeeChange', versioned: true })
  async approveChange(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['VendorPayeeApproval']): Promise<CommandResult> {
    this.require(access, PERMISSIONS.approveVendorPayeeChange);
    const now = new Date();
    const done = await this.payee.approve(scope.tx, id, this.version(scope), body.role, only(body.note), scope.tenant.membershipId, now);
    await this.bankEvent(scope, now, 'vnd.bank_change_approved', id, done.request.contractorId, done.request.version, { role: body.role, activated: done.account !== null, account_id: done.account?.id ?? null });
    return commandResult(scope, done.request.status, done.request.version, id);
  }

  @Post('vendor/payee-changes/:id/callback')
  @HttpCode(200)
  @OperationId('recordVendorPayeeCallback')
  @Command({ operation: 'recordVendorPayeeCallback', versioned: true })
  async callback(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['VendorPayeeCallback']): Promise<CommandResult> {
    this.require(access, PERMISSIONS.recordVendorPayeeCallback);
    const now = new Date();
    const done = await this.payee.callback(scope.tx, id, this.version(scope), { outcome: body.outcome, calledNumber: body.called_number, usedNumberOnFile: body.used_number_on_file, note: only(body.note) }, scope.tenant.membershipId, now);
    await this.bankEvent(scope, now, 'vnd.bank_change_called_back', id, done.request.contractorId, done.request.version, { outcome: body.outcome, number_last4: done.request.callbackNumberLast4, activated: done.account !== null, account_id: done.account?.id ?? null });
    return commandResult(scope, done.request.status, done.request.version, id);
  }

  @Post('vendor/payee-changes/:id/cancel')
  @HttpCode(200)
  @OperationId('cancelVendorPayeeChange')
  @Command({ operation: 'cancelVendorPayeeChange', versioned: true })
  async cancelChange(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['VendorReason']): Promise<CommandResult> {
    this.require(access, PERMISSIONS.cancelVendorPayeeChange);
    const now = new Date();
    const row = await this.payee.close(scope.tx, id, this.version(scope), 'CANCEL', body.reason, scope.tenant.membershipId, now);
    await this.bankEvent(scope, now, 'vnd.bank_change_cancelled', id, row.contractorId, row.version, {}, body.reason);
    return commandResult(scope, row.status, row.version, id);
  }

  @Post('vendor/payee-changes/:id/reject')
  @HttpCode(200)
  @OperationId('rejectVendorPayeeChange')
  @Command({ operation: 'rejectVendorPayeeChange', versioned: true })
  async rejectChange(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['VendorReason']): Promise<CommandResult> {
    this.require(access, PERMISSIONS.rejectVendorPayeeChange);
    const now = new Date();
    const row = await this.payee.close(scope.tx, id, this.version(scope), 'REJECT', body.reason, scope.tenant.membershipId, now);
    await this.bankEvent(scope, now, 'vnd.bank_change_rejected', id, row.contractorId, row.version, {}, body.reason);
    return commandResult(scope, row.status, row.version, id);
  }

  @Post('vendor/payee-accounts/:id/close')
  @HttpCode(200)
  @OperationId('closeVendorPayeeAccount')
  @Command({ operation: 'closeVendorPayeeAccount', versioned: true })
  async closeAccount(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['VendorReason']): Promise<CommandResult> {
    this.require(access, PERMISSIONS.closeVendorPayeeAccount);
    const now = new Date();
    const row = await this.payee.closeAccount(scope.tx, id, this.version(scope), body.reason, scope.tenant.membershipId, now);
    await announce(scope, now, { action: 'vnd.bank_account_closed', resourceType: 'contractor_bank_account', resourceId: id, classification: CLASS.bank, version: row.version, eventType: 'vnd.bank.changed.v1', reason: body.reason, diff: { contractor_id: row.contractorId, account_no_masked: row.accountNoMasked } });
    return commandResult(scope, 'CLOSED', row.version, id);
  }

  // -- Certificates and key staff -------------------------------------------------------------------------------------------------------------------------------------------------------

  @Post('vendor/contractors/:id/qualifications')
  @HttpCode(200)
  @OperationId('addVendorQualification')
  @Command({ operation: 'addVendorQualification' })
  async addQualification(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['VendorQualificationNew']): Promise<CommandResult> {
    this.require(access, PERMISSIONS.addVendorQualification);
    const row = await this.qualifications.addQualification(
      scope.tx,
      id,
      { kind: body.kind as QualificationKind, certificateNo: body.certificate_no, grade: body.grade as QualificationGrade | undefined, scope: only(body.scope), issuer: body.issuer, issuedOn: body.issued_on, expiresOn: body.expires_on, documentId: only(body.document_id) },
      scope.tenant.membershipId,
    );
    await announce(scope, new Date(), { action: 'vnd.qualification_added', resourceType: 'contractor_qualification', resourceId: row.id, classification: CLASS.plain, version: row.version, eventType: 'vnd.qualification.changed.v1', diff: { contractor_id: id, kind: row.kind, grade: row.grade, expires_on: row.expiresOn } });
    return commandResult(scope, 'CREATED', row.version, row.id);
  }

  @Post('vendor/contractors/:id/key-staff')
  @HttpCode(200)
  @OperationId('addVendorKeyStaff')
  @Command({ operation: 'addVendorKeyStaff' })
  async addKeyStaff(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['VendorKeyStaffNew']): Promise<CommandResult> {
    this.require(access, PERMISSIONS.addVendorKeyStaff);
    const row = await this.qualifications.addKeyStaff(
      scope.tx,
      id,
      { staffRole: body.staff_role as StaffRole, personName: body.person_name, qualificationTitle: body.qualification_title, certificateNo: only(body.certificate_no), issuedOn: body.issued_on, expiresOn: body.expires_on, documentId: only(body.document_id) },
      scope.tenant.membershipId,
    );
    await announce(scope, new Date(), { action: 'vnd.key_staff_added', resourceType: 'contractor_key_staff', resourceId: row.id, classification: CLASS.profile, version: row.version, eventType: 'vnd.qualification.changed.v1', diff: { contractor_id: id, staff_role: row.staffRole, expires_on: row.expiresOn } });
    return commandResult(scope, 'CREATED', row.version, row.id);
  }

  private async verifyCertificate(scope: CommandScope, access: EffectiveAccess, permission: string, kind: 'QUALIFICATION' | 'KEY_STAFF', id: string): Promise<CommandResult> {
    this.require(access, permission);
    const row = await this.qualifications.verify(scope.tx, kind, id, this.version(scope), scope.tenant.membershipId);
    await announce(scope, new Date(), { action: 'vnd.certificate_verified', resourceType: kind === 'QUALIFICATION' ? 'contractor_qualification' : 'contractor_key_staff', resourceId: id, classification: CLASS.plain, version: row.version, eventType: 'vnd.qualification.changed.v1', diff: { contractor_id: row.contractorId, subject: kind } });
    return commandResult(scope, 'VERIFIED', row.version, id);
  }

  private async revokeCertificate(scope: CommandScope, access: EffectiveAccess, permission: string, kind: 'QUALIFICATION' | 'KEY_STAFF', id: string, reason: string): Promise<CommandResult> {
    this.require(access, permission);
    const row = await this.qualifications.revoke(scope.tx, kind, id, this.version(scope), reason, scope.tenant.membershipId);
    await announce(scope, new Date(), { action: 'vnd.certificate_revoked', resourceType: kind === 'QUALIFICATION' ? 'contractor_qualification' : 'contractor_key_staff', resourceId: id, classification: CLASS.plain, version: row.version, eventType: 'vnd.qualification.changed.v1', reason, diff: { contractor_id: row.contractorId, subject: kind } });
    return commandResult(scope, 'REVOKED', row.version, id);
  }

  @Post('vendor/qualifications/:id/verification')
  @HttpCode(200)
  @OperationId('verifyVendorQualification')
  @Command({ operation: 'verifyVendorQualification', versioned: true })
  verifyQualification(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    return this.verifyCertificate(scope, access, PERMISSIONS.verifyVendorQualification, 'QUALIFICATION', id);
  }

  @Post('vendor/key-staff/:id/verification')
  @HttpCode(200)
  @OperationId('verifyVendorKeyStaff')
  @Command({ operation: 'verifyVendorKeyStaff', versioned: true })
  verifyKeyStaff(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    return this.verifyCertificate(scope, access, PERMISSIONS.verifyVendorKeyStaff, 'KEY_STAFF', id);
  }

  @Post('vendor/qualifications/:id/revocation')
  @HttpCode(200)
  @OperationId('revokeVendorQualification')
  @Command({ operation: 'revokeVendorQualification', versioned: true })
  revokeQualification(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['VendorReason']): Promise<CommandResult> {
    return this.revokeCertificate(scope, access, PERMISSIONS.revokeVendorQualification, 'QUALIFICATION', id, body.reason);
  }

  @Post('vendor/key-staff/:id/revocation')
  @HttpCode(200)
  @OperationId('revokeVendorKeyStaff')
  @Command({ operation: 'revokeVendorKeyStaff', versioned: true })
  revokeKeyStaff(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['VendorReason']): Promise<CommandResult> {
    return this.revokeCertificate(scope, access, PERMISSIONS.revokeVendorKeyStaff, 'KEY_STAFF', id, body.reason);
  }

  @Post('vendor/packages/:id/requirements')
  @HttpCode(200)
  @OperationId('setVendorPackageRequirements')
  @Command({ operation: 'setVendorPackageRequirements' })
  async setRequirements(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['VendorRequirementsSetRequest']): Promise<CommandResult> {
    this.require(access, PERMISSIONS.setVendorPackageRequirements);
    const rows = await this.qualifications.setRequirements(
      scope.tx,
      id,
      body.requirements.map((one) => ({ kind: one.kind as QualificationKind, minGrade: (one.min_grade ?? null) as QualificationGrade | null, scopeKeyword: one.scope_keyword ?? null })),
      scope.tenant.membershipId,
    );
    await announce(scope, new Date(), { action: 'vnd.package_requirements_set', resourceType: 'package_qualification_requirement', resourceId: id, classification: CLASS.plain, version: 1, eventType: 'vnd.qualification.changed.v1', diff: { package_id: id, kinds: rows.map((row) => row.kind) } });
    return commandResult(scope, 'SET', 1, id);
  }

  // -- The debarment case -------------------------------------------------------------------------------------------------------------------------------------------------------------

  private async caseEvent(scope: CommandScope, now: Date, action: string, row: CaseRow, extra: Record<string, unknown> = {}, reason?: string): Promise<void> {
    await announce(scope, now, {
      action,
      resourceType: 'restriction_case',
      resourceId: row.id,
      classification: CLASS.caseRecord,
      version: row.version,
      eventType: 'vnd.restriction_case.moved.v1',
      reason,
      diff: { case_no: row.caseNo, status: row.status, subject_kind: row.subjectKind, contractor_id: row.contractorId, joint_venture_id: row.jointVentureId, ...extra },
    });
  }

  @Post('vendor/restriction-cases')
  @HttpCode(200)
  @OperationId('openVendorRestrictionCase')
  @Command({ operation: 'openVendorRestrictionCase' })
  async openCase(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['VendorCaseNew']): Promise<CommandResult> {
    this.require(access, PERMISSIONS.openVendorRestrictionCase);
    const now = new Date();
    const row = await this.cases.open(
      scope.tx,
      { subjectKind: body.subject_kind, contractorId: only(body.contractor_id), jointVentureId: only(body.joint_venture_id), triggerKind: body.trigger_kind as RestrictionTrigger, triggerRef: only(body.trigger_ref), violationGroups: body.violation_groups, violationSummary: body.violation_summary, violationOn: body.violation_on, proposalDocumentId: only(body.proposal_document_id) },
      scope.tenant.membershipId,
      now,
    );
    await this.caseEvent(scope, now, 'vnd.restriction_case_opened', row, { trigger_kind: row.triggerKind, decide_by: row.decideBy, violation_groups: row.violationGroups });
    return commandResult(scope, row.status, row.version, row.id);
  }

  /**
   * The hook of the national network (docs/egp-connector.md section 10): a restriction that a file import kept as `egp_record` opens a case here. The record is the evidence; nothing is written to the register of
   * restrictions until the case is decided and put into effect on a decision paper of the tenant.
   */
  @Post('vendor/restriction-cases/from-egp-record')
  @HttpCode(200)
  @OperationId('openVendorRestrictionCaseFromEgpRecord')
  @Command({ operation: 'openVendorRestrictionCaseFromEgpRecord' })
  async openFromEgp(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['VendorCaseFromEgp']): Promise<CommandResult> {
    this.require(access, PERMISSIONS.openVendorRestrictionCaseFromEgpRecord);
    const now = new Date();
    const row = await this.cases.openFromEgpRecord(scope.tx, body.egp_record_id, { violationGroups: body.violation_groups, violationSummary: only(body.violation_summary), proposalDocumentId: only(body.proposal_document_id) }, scope.tenant.membershipId, now);
    await this.caseEvent(scope, now, 'vnd.restriction_case_opened', row, { trigger_kind: 'EGP_IMPORT', egp_record_id: body.egp_record_id, decide_by: row.decideBy });
    return commandResult(scope, row.status, row.version, row.id);
  }

  @Post('vendor/restriction-cases/:id/moves')
  @HttpCode(200)
  @OperationId('advanceVendorRestrictionCase')
  @Command({ operation: 'advanceVendorRestrictionCase', versioned: true })
  async advanceCase(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['VendorCaseMove']): Promise<CommandResult> {
    this.require(access, PERMISSIONS.advanceVendorRestrictionCase);
    const now = new Date();
    const actor = scope.tenant.membershipId;
    const version = this.version(scope);
    let row: CaseRow;
    switch (body.move) {
      case 'SEND_NOTICE':
        row = await this.cases.sendNotice(scope.tx, id, version, only(body.notice_document_id), actor, now);
        break;
      case 'RECORD_RESPONSE':
        if (body.summary === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'summary');
        row = await this.cases.recordResponse(scope.tx, id, version, { summary: body.summary, documentId: only(body.response_document_id) }, actor, now);
        break;
      case 'CLOSE_NO_RESPONSE':
        row = await this.cases.closeNoResponse(scope.tx, id, version, actor, now);
        break;
      case 'WITHDRAW':
        if (body.reason === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'reason');
        row = await this.cases.withdraw(scope.tx, id, version, body.reason, actor, now);
        break;
      default:
        throw new DomainError('VALIDATION_FAILED', 422, 'move');
    }
    await this.caseEvent(scope, now, `vnd.restriction_case_${body.move.toLowerCase()}`, row, { move: body.move }, body.reason);
    return commandResult(scope, row.status, row.version, id);
  }

  @Post('vendor/restriction-cases/:id/decision')
  @HttpCode(200)
  @OperationId('decideVendorRestrictionCase')
  @Command({ operation: 'decideVendorRestrictionCase', versioned: true })
  async decideCase(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['VendorCaseDecision']): Promise<CommandResult> {
    this.require(access, PERMISSIONS.decideVendorRestrictionCase);
    const now = new Date();
    const row = await this.cases.decide(
      scope.tx,
      id,
      this.version(scope),
      { decision: body.decision, reason: body.reason, scope: body.scope as RestrictionScope | undefined, banMonths: body.ban_months, effectiveFrom: only(body.effective_from), decisionDocumentId: only(body.decision_document_id), culpableMemberIds: body.culpable_member_ids },
      scope.tenant.membershipId,
      now,
    );
    await this.caseEvent(scope, now, 'vnd.restriction_case_decided', row, { decision: row.decision, ban_months: row.banMonths, effective_from: row.effectiveFrom, effective_until: row.effectiveUntil, decided_late: row.decidedLate, decision_scope: row.decisionScope }, body.reason);
    return commandResult(scope, row.status, row.version, id);
  }

  @Post('vendor/restriction-cases/:id/effect')
  @HttpCode(200)
  @OperationId('putVendorRestrictionIntoEffect')
  @Command({ operation: 'putVendorRestrictionIntoEffect', versioned: true })
  async effect(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    this.require(access, PERMISSIONS.putVendorRestrictionIntoEffect);
    const now = new Date();
    const done = await this.cases.putIntoEffect(scope.tx, id, this.version(scope), scope.tenant.membershipId, now);
    await this.caseEvent(scope, now, 'vnd.restriction_case_put_into_effect', done.row, { restrictions: done.restrictions.length });
    // Each restriction is a legal record of the register that the gates read: it has its own audit row and its event, as one recorded by hand does. The event is the hook for BID, CTR and PAY consumers.
    for (const restriction of done.restrictions) {
      await scope.audit({
        action: 'bid.contractor_restriction_recorded',
        resourceType: 'contractor_restriction',
        resourceId: restriction.restrictionId,
        classification: CLASS.caseRecord,
        diff: { contractor_id: restriction.contractorId, kind: 'DEBARMENT', source: 'DECISION', effective_from: restriction.effectiveFrom, effective_until: restriction.effectiveUntil, case_id: id },
      });
      await scope.emit({
        aggregateType: 'contractor_restriction',
        aggregateId: restriction.restrictionId,
        aggregateVersion: 1,
        type: 'vnd.restriction.effective.v1',
        schemaVersion: 1,
        payload: { tenant_id: scope.tenant.tenantId, restriction_id: restriction.restrictionId, contractor_id: restriction.contractorId, case_id: id, kind: 'DEBARMENT', effective_from: restriction.effectiveFrom, effective_until: restriction.effectiveUntil, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
        eventKey: `contractor_restriction:${restriction.restrictionId}:effective`,
      });
    }
    return commandResult(scope, done.row.status, done.row.version, id);
  }

  @Post('vendor/restriction-cases/:id/lift')
  @HttpCode(200)
  @OperationId('liftVendorRestrictionCase')
  @Command({ operation: 'liftVendorRestrictionCase', versioned: true })
  async lift(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['VendorCaseLift']): Promise<CommandResult> {
    this.require(access, PERMISSIONS.liftVendorRestrictionCase);
    const now = new Date();
    const row = await this.cases.lift(scope.tx, id, this.version(scope), { reason: body.reason, documentId: only(body.document_id) }, scope.tenant.membershipId, now);
    await this.caseEvent(scope, now, 'vnd.restriction_case_lifted', row, {}, body.reason);
    return commandResult(scope, row.status, row.version, id);
  }

  // -- Bid-conduct events and joint ventures ----------------------------------------------------------------------------------------------------------------------------------------

  @Post('vendor/reputation-events')
  @HttpCode(200)
  @OperationId('recordVendorReputationEvent')
  @Command({ operation: 'recordVendorReputationEvent' })
  async recordEvent(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['VendorReputationEventNew']): Promise<CommandResult> {
    this.require(access, PERMISSIONS.recordVendorReputationEvent);
    const now = new Date();
    const row = await this.reputation.record(scope.tx, { contractorId: body.contractor_id, packageId: only(body.package_id), contractId: only(body.contract_id), behaviourCode: body.behaviour_code, eventOn: body.event_on, description: body.description, evidenceDocumentId: only(body.evidence_document_id) }, scope.tenant.membershipId, now);
    await announce(scope, now, { action: 'vnd.reputation_event_recorded', resourceType: 'contractor_reputation_event', resourceId: row.id, classification: CLASS.plain, version: row.version, eventType: 'vnd.reputation.changed.v1', diff: { contractor_id: row.contractorId, behaviour_code: row.behaviourCode, event_on: row.eventOn, post_due_at: row.postDueAt, package_id: row.packageId } });
    return commandResult(scope, row.status, row.version, row.id);
  }

  @Post('vendor/reputation-events/:id/posting')
  @HttpCode(200)
  @OperationId('postVendorReputationEvent')
  @Command({ operation: 'postVendorReputationEvent', versioned: true })
  async postEvent(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['VendorReputationPost']): Promise<CommandResult> {
    this.require(access, PERMISSIONS.postVendorReputationEvent);
    const now = new Date();
    const row = await this.reputation.post(scope.tx, id, this.version(scope), body.receipt, scope.tenant.membershipId, now);
    await announce(scope, now, { action: 'vnd.reputation_event_posted', resourceType: 'contractor_reputation_event', resourceId: id, classification: CLASS.plain, version: row.version, eventType: 'vnd.reputation.changed.v1', diff: { contractor_id: row.contractorId, posting_ref: row.postingRef, clock: row.clock } });
    return commandResult(scope, row.status, row.version, id);
  }

  @Post('vendor/reputation-events/:id/retraction')
  @HttpCode(200)
  @OperationId('retractVendorReputationEvent')
  @Command({ operation: 'retractVendorReputationEvent', versioned: true })
  async retractEvent(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['VendorReputationRetract']): Promise<CommandResult> {
    this.require(access, PERMISSIONS.retractVendorReputationEvent);
    const now = new Date();
    const row = await this.reputation.retract(scope.tx, id, this.version(scope), body.reason, scope.tenant.membershipId, now);
    await announce(scope, now, { action: 'vnd.reputation_event_retracted', resourceType: 'contractor_reputation_event', resourceId: id, classification: CLASS.plain, version: row.version, eventType: 'vnd.reputation.changed.v1', reason: body.reason, diff: { contractor_id: row.contractorId } });
    return commandResult(scope, row.status, row.version, id);
  }

  @Post('vendor/joint-ventures')
  @HttpCode(200)
  @OperationId('createVendorJointVenture')
  @Command({ operation: 'createVendorJointVenture' })
  async createVenture(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['VendorVentureNew']): Promise<CommandResult> {
    this.require(access, PERMISSIONS.createVendorJointVenture);
    const now = new Date();
    const row = await this.ventures.create(
      scope.tx,
      { name: body.name, members: body.members.map((member) => ({ contractorId: member.contractor_id, sharePct: member.share_pct, lead: member.lead })), agreementDocumentId: only(body.agreement_document_id), packageId: only(body.package_id), startsOn: only(body.starts_on) },
      scope.tenant.membershipId,
      todayOf(now),
    );
    await announce(scope, now, { action: 'vnd.joint_venture_created', resourceType: 'joint_venture', resourceId: row.id, classification: CLASS.plain, version: row.version, eventType: 'vnd.joint_venture.changed.v1', diff: { lead_contractor_id: row.leadContractorId, members: row.members.map((member) => ({ contractor_id: member.contractorId, share_pct: member.sharePct })) } });
    return commandResult(scope, row.status, row.version, row.id);
  }

  @Post('vendor/joint-ventures/:id/end')
  @HttpCode(200)
  @OperationId('endVendorJointVenture')
  @Command({ operation: 'endVendorJointVenture', versioned: true })
  async endVenture(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['VendorReason']): Promise<CommandResult> {
    this.require(access, PERMISSIONS.endVendorJointVenture);
    const now = new Date();
    const row = await this.ventures.end(scope.tx, id, this.version(scope), body.reason, scope.tenant.membershipId, todayOf(now));
    await announce(scope, now, { action: 'vnd.joint_venture_ended', resourceType: 'joint_venture', resourceId: id, classification: CLASS.plain, version: row.version, eventType: 'vnd.joint_venture.changed.v1', reason: body.reason, diff: { ends_on: row.endsOn } });
    return commandResult(scope, row.status, row.version, id);
  }
}

