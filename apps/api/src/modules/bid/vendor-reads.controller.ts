import { Controller, Get, Inject, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import {
  BidWorkflowReads,
  GovernancePolicyPort,
  RestrictionCaseStore,
  TenantDatabase,
  VendorGate,
  VendorPayeeStore,
  VendorPolicyReader,
  VendorProfileStore,
  VendorQualificationStore,
  VendorReputationStore,
  VendorVentureStore,
  factsOfProfile,
} from '@machvon/db';
import type { TenantTx } from '@machvon/db';
import {
  DomainError,
  GATE_ACTIONS,
  GATE_CHECKS_BY_ACTION,
  RESTRICTION_CASE_STATES,
  checkTaxCode,
  profileCoverage,
} from '@machvon/kernel';
import type { EffectiveAccess, GateAction, RestrictionCaseState, TenantContext } from '@machvon/kernel';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { holdsOnWholeTenant } from '../adm/tenant-authority';
import { accountDto, caseDto, changeDto, coverageDto, duplicateDto, keyStaffDto, ownerDto, policyDto, profileDto, qualificationDto, reputationDto, taxCheckDto, todayOf, ventureDto, verdictDto } from './vendor-view';
import type { Caller } from './vendor-view';

const FIGURE_CODES = ['VENDOR_PROFILE_COVERAGE', 'VENDOR_DEBARMENT_IN_TIME', 'VENDOR_REPUTATION_POSTED_IN_TIME', 'VENDOR_ACCOUNT_CHANGES'] as const;

function text(value: unknown, field: string, max = 100): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value === '' || value.length > max) throw new DomainError('VALIDATION_FAILED', 422, field);
  return value;
}

function flag(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value !== 'true' && value !== 'false') throw new DomainError('VALIDATION_FAILED', 422, field);
  return value === 'true';
}

function uuid(value: unknown, field: string): string | undefined {
  const found = text(value, field, 36);
  if (found !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(found)) throw new DomainError('VALIDATION_FAILED', 422, field);
  return found;
}

const pct = (part: number, whole: number): number | null => (whole === 0 ? null : Math.round((part * 1000) / whole) / 10);

/**
 * The reads of the management of contractors (VND-01 to VND-06, docs/vendor-management.md). The register of contractors spans the whole tenant, so every read is judged on a grant over the whole tenant (a grant on a
 * subtree is 403 `SCOPE_DENIED`); the numbers of the accounts are never read here (masked only); every figure carries the policy it rests on, with its version, formula, source and legal status. A read never writes.
 */
@Controller()
export class VendorReadsController {
  private readonly profiles = new VendorProfileStore();
  private readonly payee = new VendorPayeeStore();
  private readonly qualifications = new VendorQualificationStore();
  private readonly cases = new RestrictionCaseStore();
  private readonly ventures = new VendorVentureStore();
  private readonly reputation = new VendorReputationStore();
  private readonly policies = new VendorPolicyReader();
  private readonly gate = new VendorGate();
  private readonly people = new BidWorkflowReads();
  private readonly rules = new GovernancePolicyPort();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  private caller(tenant: TenantContext, access: EffectiveAccess): Caller {
    return { membershipId: tenant.membershipId, holds: (permission) => holdsOnWholeTenant(access, permission) };
  }

  private require(access: EffectiveAccess, permission: string): void {
    if (!holdsOnWholeTenant(access, permission)) throw new DomainError('SCOPE_DENIED', 403);
  }

  @Get('vendor/register')
  @OperationId('listVendorRegister')
  async register(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.require(access, PERMISSIONS.listVendorRegister);
    const now = new Date();
    const today = todayOf(now);
    const coverage = text(query.coverage, 'coverage', 20);
    if (coverage !== undefined && coverage !== 'COMPLETE' && coverage !== 'INCOMPLETE') throw new DomainError('VALIDATION_FAILED', 422, 'coverage');
    const verification = text(query.verification, 'verification', 20);
    if (verification !== undefined && !['UNVERIFIED', 'VERIFIED', 'REJECTED'].includes(verification)) throw new DomainError('VALIDATION_FAILED', 422, 'verification');
    const request = parsePageRequest(query.limit, query.cursor);
    return this.database.withTenant(tenant, async (tx) => {
      const profilePolicy = await this.policies.profile(tx, today);
      const expiry = await this.policies.expiry(tx, 'QUALIFICATION', today);
      const rows = await this.profiles.register(
        tx,
        { q: text(query.q, 'q', 100), verification, coverage: coverage as 'COMPLETE' | 'INCOMPLETE' | undefined, restricted: flag(query.restricted, 'restricted'), hasOpenCase: flag(query.has_open_case, 'has_open_case'), limit: request.limit, after: request.after },
        profilePolicy.value.required_before_bid,
        today,
        expiry.value.first_warning_days,
      );
      const shown = rows.slice(0, request.limit);
      const last = shown[shown.length - 1];
      return {
        items: shown.map((row) => ({
          contractor_id: row.profile.contractorId,
          tax_identifier: row.profile.taxIdentifier,
          legal_name: row.profile.legalName,
          verification_status: row.profile.verificationStatus,
          legal_rep_name: row.profile.legalRepName,
          coverage: coverageDto(row.coverage, profilePolicy.value.required_before_bid),
          restricted: row.restricted,
          open_cases: row.openCases,
          active_accounts: row.activeAccounts,
          qualifications_expiring: row.qualificationsExpiring,
          next_review_due: row.profile.nextReviewDue,
          cursor: encodeCursor({ code: row.createdAtKey, id: row.profile.contractorId }),
        })),
        next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.createdAtKey, id: last.profile.contractorId }) : null,
        profile_policy: policyDto('VENDOR_PROFILE', profilePolicy),
        as_of: now.toISOString(),
      };
    });
  }

  @Get('vendor/contractors/:id')
  @OperationId('getVendorContractor')
  async contractor(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    this.require(access, PERMISSIONS.getVendorContractor);
    const now = new Date();
    const today = todayOf(now);
    const caller = this.caller(tenant, access);
    return this.database.withTenant(tenant, async (tx) => {
      const profile = await this.profiles.require(tx, id);
      const profilePolicy = await this.policies.profile(tx, today);
      const required = profilePolicy.value.required_before_bid;
      const payeePolicy = await this.policies.payee(tx, today);
      const qualPolicy = await this.policies.expiry(tx, 'QUALIFICATION', today);
      const staffPolicy = await this.policies.expiry(tx, 'KEY_STAFF', today);
      const gatePolicy = await this.policies.gate(tx, today);
      const [owners, accounts, verdict, changes, events, qualifications, staff, restrictions, cases, reputation, factor, escalation, duplicates, ventures] = await Promise.all([
        this.profiles.owners(tx, id),
        this.payee.accounts(tx, id, now),
        this.payee.verdict(tx, id, now),
        this.payee.requests(tx, { contractorId: id, limit: 50 }),
        this.payee.events(tx, id, 100),
        this.qualifications.qualifications(tx, id),
        this.qualifications.keyStaff(tx, id),
        this.cases.restrictionLines(tx, id, today),
        this.cases.list(tx, { contractorId: id, limit: 50 }, now),
        this.reputation.list(tx, { contractorId: id, limit: 50 }, now),
        this.reputation.bidSecurityFactor(tx, id, today),
        this.cases.escalation(tx, id, now),
        this.profiles.suggestions(tx, { contractorId: id, status: 'OPEN', limit: 50 }),
        this.ventures.list(tx, { contractorId: id, limit: 50 }),
      ]);
      const names = await this.people.names(tx, [
        ...changes.flatMap((row) => [row.requestedBy, row.contractMatchBy, row.accountMatchBy, row.callbackBy]),
        ...events.map((event) => event.actorId),
        ...qualifications.flatMap((row) => [row.verifiedBy]),
        ...staff.flatMap((row) => [row.verifiedBy]),
        ...cases.flatMap((row) => [row.proposedBy, row.decidedBy]),
        ...reputation.flatMap((row) => [row.recordedBy, row.postedBy]),
      ]);
      const check = checkTaxCode(profile.taxIdentifier);
      const coverage = profileCoverage(factsOfProfile(profile), required);
      return {
        profile: profileDto(profile),
        tax_check: taxCheckDto(check),
        coverage: coverageDto(coverage, required),
        owners: owners.map(ownerDto),
        accounts: accounts.map(accountDto),
        payee_verdict: verdictDto(verdict.verdict, verdict.policyVersion, verdict.unverified),
        payee_changes: changes.map((row) => changeDto(row, names, caller)),
        bank_events: events.map((event) => ({ id: event.id, change_request_id: event.changeRequestId, account_id: event.accountId, action: event.action, actor_name: names.get(event.actorId) ?? null, note: event.note, occurred_at: event.occurredAt })),
        qualifications: qualifications.map((row) => qualificationDto(row, names, today, qualPolicy.value, caller)),
        key_staff: staff.map((row) => keyStaffDto(row, names, today, staffPolicy.value, caller)),
        restrictions: restrictions.map((row) => ({ id: row.id, kind: row.kind, source: row.source, effective_from: row.effectiveFrom, effective_until: row.effectiveUntil, decision_document_id: row.decisionDocumentId, case_id: row.caseId, lifted: row.lifted, in_force: row.inForce })),
        cases: cases.map((row) => caseDto(row, names)),
        reputation_events: reputation.map((row) => reputationDto(row, names, caller)),
        bid_security: { multiplier: factor.multiplier, until: factor.until, event_ids: factor.eventIds, policy_version: factor.policyVersion },
        escalation: { decisions_in_force: escalation.decisionsInForce, suggestion: escalation.suggestion },
        duplicates: duplicates.map(duplicateDto),
        ventures: ventures.map(ventureDto),
        policies: {
          profile: policyDto('VENDOR_PROFILE', profilePolicy),
          payee: policyDto('VENDOR_PAYEE_ACCOUNT', payeePolicy),
          qualification_expiry: policyDto('QUALIFICATION', qualPolicy),
          key_staff_expiry: policyDto('KEY_STAFF', staffPolicy),
          gate: policyDto('VENDOR_GATE', gatePolicy),
        },
        actions: {
          update_profile: caller.holds(PERMISSIONS.updateVendorProfile),
          manage_owners: caller.holds(PERMISSIONS.addVendorOwner),
          request_payee_change: caller.holds(PERMISSIONS.requestVendorPayeeChange),
          manage_certificates: caller.holds(PERMISSIONS.addVendorQualification),
          propose_restriction: caller.holds(PERMISSIONS.openVendorRestrictionCase),
          record_reputation_event: caller.holds(PERMISSIONS.recordVendorReputationEvent),
          manage_ventures: caller.holds(PERMISSIONS.createVendorJointVenture),
          decide_duplicates: caller.holds(PERMISSIONS.decideVendorDuplicate),
        },
        as_of: now.toISOString(),
      };
    });
  }

  @Get('vendor/duplicates')
  @OperationId('listVendorDuplicates')
  async duplicates(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.require(access, PERMISSIONS.listVendorDuplicates);
    const now = new Date();
    const status = text(query.status, 'status', 20);
    if (status !== undefined && !['OPEN', 'DISMISSED', 'MERGE_REQUESTED'].includes(status)) throw new DomainError('VALIDATION_FAILED', 422, 'status');
    const contractorId = uuid(query.contractor_id, 'contractor_id');
    return this.database.withTenant(tenant, async (tx) => {
      const policy = await this.policies.duplicateWeights(tx, todayOf(now));
      const rows = await this.profiles.suggestions(tx, { contractorId, status: status as 'OPEN' | 'DISMISSED' | 'MERGE_REQUESTED' | undefined });
      return { items: rows.map(duplicateDto), policy: policyDto('VENDOR_DUPLICATE_SIGNALS', policy), as_of: now.toISOString() };
    });
  }

  @Get('vendor/payee-changes')
  @OperationId('listVendorPayeeChanges')
  async payeeChanges(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.require(access, PERMISSIONS.listVendorPayeeChanges);
    const now = new Date();
    const status = text(query.status, 'status', 20);
    if (status !== undefined && !['REQUESTED', 'ACTIVATED', 'REJECTED', 'CANCELLED', 'EXPIRED'].includes(status)) throw new DomainError('VALIDATION_FAILED', 422, 'status');
    const contractorId = uuid(query.contractor_id, 'contractor_id');
    const caller = this.caller(tenant, access);
    return this.database.withTenant(tenant, async (tx) => {
      const policy = await this.policies.payee(tx, todayOf(now));
      const rows = await this.payee.requests(tx, { contractorId, status: status as 'REQUESTED' | undefined, limit: 200 });
      const names = await this.people.names(tx, rows.flatMap((row) => [row.requestedBy, row.contractMatchBy, row.accountMatchBy, row.callbackBy]));
      return { items: rows.map((row) => changeDto(row, names, caller)), policy: policyDto('VENDOR_PAYEE_ACCOUNT', policy), as_of: now.toISOString() };
    });
  }

  @Get('vendor/restriction-cases')
  @OperationId('listVendorRestrictionCases')
  async restrictionCases(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.require(access, PERMISSIONS.listVendorRestrictionCases);
    const now = new Date();
    const status = text(query.status, 'status', 30);
    if (status !== undefined && !(RESTRICTION_CASE_STATES as readonly string[]).includes(status)) throw new DomainError('VALIDATION_FAILED', 422, 'status');
    const open = flag(query.open, 'open');
    const contractorId = uuid(query.contractor_id, 'contractor_id');
    return this.database.withTenant(tenant, async (tx) => {
      const policy = await this.policies.debarment(tx, todayOf(now));
      const rows = await this.cases.list(tx, { status: status as RestrictionCaseState | undefined, open, contractorId, limit: 200 }, now);
      const figures = await this.cases.figures(tx, now);
      const names = await this.people.names(tx, rows.flatMap((row) => [row.proposedBy, row.decidedBy]));
      return {
        items: rows.map((row) => caseDto(row, names)),
        policy: policyDto('VENDOR_DEBARMENT', policy),
        counts: { open: figures.open, overdue: figures.overdueOpen, decided_in_time: figures.decidedInTime, decided_late: figures.decidedLate },
        as_of: now.toISOString(),
      };
    });
  }

  @Get('vendor/restriction-cases/:id')
  @OperationId('getVendorRestrictionCase')
  async restrictionCase(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    this.require(access, PERMISSIONS.getVendorRestrictionCase);
    const now = new Date();
    const caller = this.caller(tenant, access);
    return this.database.withTenant(tenant, async (tx) => {
      const row = await this.cases.require(tx, id, now);
      const [events, members, policy, periods] = await Promise.all([this.cases.events(tx, id), this.cases.members(tx, id), this.policies.debarment(tx, todayOf(now)), this.policies.periods(tx, todayOf(now))]);
      const subjectIds = row.contractorId === null ? members.map((member) => member.contractorId) : [row.contractorId];
      const escalation = subjectIds[0] === undefined ? { decisionsInForce: 0, suggestion: 'NONE' as const } : await this.cases.escalation(tx, subjectIds[0], now);
      const names = await this.people.names(tx, [row.proposedBy, row.decidedBy, ...events.map((event) => event.actorId)]);
      const open = row.status === 'PROPOSED' || row.status === 'NOTICE_SENT' || row.status === 'RESPONSE_RECEIVED';
      return {
        case: caseDto(row, names),
        notice_document_id: row.noticeDocumentId,
        proposal_document_id: row.proposalDocumentId,
        response_document_id: row.responseDocumentId,
        response_summary: row.responseSummary,
        decision_document_id: row.decisionDocumentId,
        decision_reason: row.decisionReason,
        end_reason: row.endReason,
        lift_document_id: row.liftDocumentId,
        members: members.map((member) => ({ contractor_id: member.contractorId, contractor_name: member.contractorName, restriction_id: member.restrictionId })),
        events: events.map((event) => ({ id: event.id, move: event.move, from_status: event.fromStatus, to_status: event.toStatus, actor_name: names.get(event.actorId) ?? null, note: event.note, occurred_at: event.occurredAt })),
        escalation: { decisions_in_force: escalation.decisionsInForce, suggestion: escalation.suggestion },
        periods: periods.value,
        policy: policyDto('VENDOR_DEBARMENT', policy),
        may_advance: open && caller.holds(PERMISSIONS.advanceVendorRestrictionCase),
        may_decide: row.status === 'RESPONSE_RECEIVED' && row.proposedBy !== caller.membershipId && caller.holds(PERMISSIONS.decideVendorRestrictionCase),
        may_put_into_effect: row.status === 'DECIDED' && row.decision === 'BAN' && caller.holds(PERMISSIONS.putVendorRestrictionIntoEffect),
        may_lift: (row.status === 'DECIDED' || row.status === 'EFFECTIVE') && caller.holds(PERMISSIONS.liftVendorRestrictionCase),
        as_of: now.toISOString(),
      };
    });
  }

  @Get('vendor/reputation-events')
  @OperationId('listVendorReputationEvents')
  async reputationEvents(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.require(access, PERMISSIONS.listVendorReputationEvents);
    const now = new Date();
    const status = text(query.status, 'status', 20);
    if (status !== undefined && !['RECORDED', 'POSTED', 'RETRACTED'].includes(status)) throw new DomainError('VALIDATION_FAILED', 422, 'status');
    const contractorId = uuid(query.contractor_id, 'contractor_id');
    const caller = this.caller(tenant, access);
    return this.database.withTenant(tenant, async (tx) => {
      const today = todayOf(now);
      const rows = await this.reputation.list(tx, { contractorId, status: status as 'RECORDED' | undefined, limit: 200 }, now);
      const names = await this.people.names(tx, rows.flatMap((row) => [row.recordedBy, row.postedBy]));
      return {
        items: rows.map((row) => reputationDto(row, names, caller)),
        policy: policyDto('VENDOR_REPUTATION', await this.policies.reputation(tx, today)),
        deadline_policy: policyDto('REPUTATION_EVENT', await this.policies.postingDeadline(tx, today)),
        as_of: now.toISOString(),
      };
    });
  }

  @Get('vendor/joint-ventures')
  @OperationId('listVendorJointVentures')
  async jointVentures(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.require(access, PERMISSIONS.listVendorJointVentures);
    const now = new Date();
    const status = text(query.status, 'status', 20);
    if (status !== undefined && status !== 'ACTIVE' && status !== 'ENDED') throw new DomainError('VALIDATION_FAILED', 422, 'status');
    const contractorId = uuid(query.contractor_id, 'contractor_id');
    const rows = await this.database.withTenant(tenant, (tx) => this.ventures.list(tx, { status, contractorId, limit: 200 }));
    return { items: rows.map(ventureDto), as_of: now.toISOString() };
  }

  @Get('vendor/expiries')
  @OperationId('listVendorExpiries')
  async expiries(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess): Promise<Record<string, unknown>> {
    this.require(access, PERMISSIONS.listVendorExpiries);
    const now = new Date();
    const today = todayOf(now);
    return this.database.withTenant(tenant, async (tx) => {
      const qualification = await this.policies.expiry(tx, 'QUALIFICATION', today);
      const keyStaff = await this.policies.expiry(tx, 'KEY_STAFF', today);
      const items = await this.qualifications.expiring(tx, today, { qualification: qualification.value, keyStaff: keyStaff.value });
      return {
        items: items.map((item) => ({ subject: item.subject, id: item.id, contractor_id: item.contractorId, contractor_name: item.contractorName, label: item.label, expires_on: item.expiresOn, state: item.state })),
        policy: policyDto('QUALIFICATION', qualification),
        as_of: now.toISOString(),
      };
    });
  }

  @Get('vendor/figures')
  @OperationId('getVendorFigures')
  async figures(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess): Promise<Record<string, unknown>> {
    this.require(access, PERMISSIONS.getVendorFigures);
    const now = new Date();
    const today = todayOf(now);
    return this.database.withTenant(tenant, async (tx) => {
      const profilePolicy = await this.policies.profile(tx, today);
      const expiry = await this.policies.expiry(tx, 'QUALIFICATION', today);
      const verified = await this.profiles.register(tx, { verification: 'VERIFIED', limit: 1000 }, profilePolicy.value.required_before_bid, today, expiry.value.first_warning_days);
      const complete = verified.filter((row) => row.coverage.complete).length;
      const cases = await this.cases.figures(tx, now);
      const events = await this.reputation.figures(tx, now);
      const bank = await this.bankFigures(tx);
      const indicators = [];
      for (const code of FIGURE_CODES) {
        const rule = await this.rules.get(tx, 'KPI_DEFINITION', code, today);
        if (rule === undefined) continue;
        indicators.push({ code, name: String(rule.params.name ?? code), formula: rule.provenance?.formula ?? String(rule.params.formula ?? ''), source: String(rule.params.source ?? rule.provenance?.source ?? ''), unverified: rule.unverified });
      }
      return {
        profile_coverage: { complete, total: verified.length, pct: pct(complete, verified.length) },
        debarment: { decided_in_time: cases.decidedInTime, decided_late: cases.decidedLate, overdue_open: cases.overdueOpen, open: cases.open, in_time_pct: pct(cases.decidedInTime, cases.decidedInTime + cases.decidedLate + cases.overdueOpen) },
        reputation: { posted_in_time: events.postedInTime, posted_late: events.postedLate, overdue_open: events.overdueOpen, open: events.open, in_time_pct: pct(events.postedInTime, events.postedInTime + events.postedLate + events.overdueOpen) },
        payee: bank,
        indicators,
        as_of: now.toISOString(),
      };
    });
  }

  private async bankFigures(tx: TenantTx): Promise<Record<string, number>> {
    const [row] = await tx.query<{ requested: number; with_callback: number; waiting: number }>(
      `select (select count(*) from machvon.contractor_bank_change_request)::int as requested,
              (select count(*) from machvon.contractor_bank_change_request where callback_outcome is not null)::int as with_callback,
              (select count(*) from machvon.contractor_bank_account where state = 'ACTIVE' and effective_after > now())::int as waiting`,
    );
    const shared = await this.payee.sharedAccounts(tx);
    return { changes_requested: row?.requested ?? 0, changes_with_callback: row?.with_callback ?? 0, accounts_waiting: row?.waiting ?? 0, shared_accounts: shared.length };
  }

  @Get('vendor/gate-check')
  @OperationId('checkVendorGate')
  async gateCheck(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.require(access, PERMISSIONS.checkVendorGate);
    const now = new Date();
    const contractorId = uuid(query.contractor_id, 'contractor_id');
    const action = text(query.action, 'action', 30);
    if (contractorId === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'contractor_id');
    if (action === undefined || !(GATE_ACTIONS as readonly string[]).includes(action)) throw new DomainError('VALIDATION_FAILED', 422, 'action');
    const gateAction = action as GateAction;
    return this.database.withTenant(tenant, async (tx) => {
      await this.profiles.require(tx, contractorId);
      try {
        const warnings = await this.gate.assertAllowed(tx, gateAction, { contractorId, now });
        return { action: gateAction, contractor_id: contractorId, allowed: true, refusal_code: null, refusal_extensions: {}, warnings: warnings.map((warning) => ({ code: warning.code, detail: warning.detail })), checks: [...GATE_CHECKS_BY_ACTION[gateAction]], as_of: now.toISOString() };
      } catch (error) {
        if (!(error instanceof DomainError) || error.status >= 500) throw error;
        return { action: gateAction, contractor_id: contractorId, allowed: false, refusal_code: error.code, refusal_extensions: error.extensions ?? {}, warnings: [], checks: [...GATE_CHECKS_BY_ACTION[gateAction]], as_of: now.toISOString() };
      }
    });
  }

  @Get('vendor/packages/:id/requirements')
  @OperationId('getVendorPackageRequirements')
  async packageRequirements(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    this.require(access, PERMISSIONS.getVendorPackageRequirements);
    const now = new Date();
    const rows = await this.database.withTenant(tenant, async (tx) => {
      if ((await tx.query('select 1 from machvon.procurement_package where id = $1::uuid', [id])).length === 0) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      return this.qualifications.requirements(tx, id);
    });
    return { package_id: id, requirements: rows.map((row) => ({ kind: row.kind, min_grade: row.minGrade, scope_keyword: row.scopeKeyword })), as_of: now.toISOString() };
  }
}
