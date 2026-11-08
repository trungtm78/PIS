import { Body, Controller, HttpCode, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { VendorFinanceStore, VendorIndependenceStore, VendorPackageControlStore, VendorPolicyReader } from '@machvon/db';
import { DomainError } from '@machvon/kernel';
import type { EffectiveAccess, FieldCipher, InterestKind } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { holdsOnWholeTenant } from '../adm/tenant-authority';
import { VENDOR_CIPHER } from './tokens';
import { todayOf } from './vendor-view';

const CLASS = { personal: 'PERSONAL', confidential: 'CONFIDENTIAL', plain: 'INTERNAL' } as const;
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
}

/** Writes the audit row (ADM-11) and the outbox event of a command; the payload carries ids and codes only: never the name of a relative, never an identity number. */
async function announce(scope: CommandScope, now: Date, item: Announcement): Promise<void> {
  await scope.audit({ action: item.action, resourceType: item.resourceType, resourceId: item.resourceId, classification: item.classification, ...(item.reason === undefined ? {} : { reason: item.reason }), diff: item.diff });
  await scope.emit({
    aggregateType: item.resourceType,
    aggregateId: item.resourceId,
    aggregateVersion: item.version,
    type: item.eventType,
    schemaVersion: 1,
    payload: { tenant_id: scope.tenant.tenantId, resource_id: item.resourceId, version: item.version, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString(), action: item.action, ...item.diff },
    eventKey: `${item.resourceType}:${item.resourceId}:${item.version}:${item.action}`,
  });
}

/**
 * The commands of the independence of the bidders of a package and of the finance of a contractor (VND-07, VND-08; docs/vendor-controls-independence-finance.md). Each runs in one transaction with its audit row
 * and its outbox event, judged by the kernel rules and the governance rules (no threshold lives here). A member declares about themselves only (the body names no other member unless the caller may also decide a
 * finding); a finding is decided by a person other than the one who ran the check; a year of finance is verified by a person other than the one who entered it. Every command needs its permission through a grant on the whole tenant.
 */
@Controller()
export class VendorIndependenceController {
  private readonly independence = new VendorIndependenceStore();
  private readonly finance = new VendorFinanceStore();
  private readonly controls = new VendorPackageControlStore();
  private readonly policies = new VendorPolicyReader();

  constructor(@Inject(VENDOR_CIPHER) private readonly cipher: FieldCipher) {}

  private require(access: EffectiveAccess, permission: string): void {
    if (!holdsOnWholeTenant(access, permission)) throw new DomainError('SCOPE_DENIED', 403);
  }

  private version(scope: CommandScope): number {
    return scope.expectedVersion ?? 0;
  }

  @Post('vendor/person-interests')
  @HttpCode(200)
  @OperationId('declareVendorPersonInterest')
  @Command({ operation: 'declareVendorPersonInterest' })
  async declareInterest(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['VendorPersonInterestNew']): Promise<CommandResult> {
    this.require(access, PERMISSIONS.declareVendorPersonInterest);
    const caller = scope.tenant.membershipId;
    const membershipId = body.membership_id ?? caller;
    if (membershipId !== caller) this.require(access, PERMISSIONS.decideVendorIndependenceFinding);
    const now = new Date();
    const tenantId = scope.tenant.tenantId;
    const row = await this.independence.declare(
      scope.tx,
      {
        membershipId,
        kind: body.kind as InterestKind,
        relatedName: body.related_name,
        relatedIdentityNumber: body.related_identity_number,
        relation: body.relation,
        contractorId: body.contractor_id,
        taxCode: body.tax_code,
        sharePct: body.share_pct,
        sinceOn: body.since_on,
        endedOn: body.ended_on,
        documentId: body.document_id,
      },
      caller,
      (value) => this.cipher.blindIndex(tenantId, 'owner-identity', value),
      todayOf(now),
    );
    await announce(scope, now, { action: 'vnd.person_interest_declared', resourceType: 'vendor_person_interest', resourceId: row.id, classification: CLASS.personal, version: row.version, eventType: 'vnd.person_interest.declared.v1', diff: { membership_id: row.membershipId, kind: row.kind, contractor_id: row.contractorId } });
    return commandResult(scope, 'CREATED', row.version, row.id);
  }

  @Post('vendor/person-interests/:id/end')
  @HttpCode(200)
  @OperationId('endVendorPersonInterest')
  @Command({ operation: 'endVendorPersonInterest', versioned: true })
  async endInterest(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['VendorPersonInterestEnd']): Promise<CommandResult> {
    this.require(access, PERMISSIONS.endVendorPersonInterest);
    const now = new Date();
    const held = await this.independence.findInterest(scope.tx, id);
    if (held === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    // A member ends their own declaration; ending another's needs the right to decide findings.
    if (held.membershipId !== scope.tenant.membershipId) this.require(access, PERMISSIONS.decideVendorIndependenceFinding);
    const row = await this.independence.end(scope.tx, id, this.version(scope), body.reason, body.ended_on ?? todayOf(now), scope.tenant.membershipId);
    await announce(scope, now, { action: 'vnd.person_interest_ended', resourceType: 'vendor_person_interest', resourceId: id, classification: CLASS.personal, version: row.version, eventType: 'vnd.person_interest.ended.v1', reason: body.reason, diff: { membership_id: row.membershipId, kind: row.kind } });
    return commandResult(scope, 'ENDED', row.version, id);
  }

  @Post('vendor/packages/:id/independence-checks')
  @HttpCode(200)
  @OperationId('runVendorIndependenceCheck')
  @Command({ operation: 'runVendorIndependenceCheck' })
  async run(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['VendorIndependenceRun']): Promise<CommandResult> {
    this.require(access, PERMISSIONS.runVendorIndependenceCheck);
    const now = new Date();
    const today = todayOf(now);
    const tenantId = scope.tenant.tenantId;
    const policy = await this.policies.independence(scope.tx, today);
    const { view, created } = await this.independence.run(
      scope.tx,
      id,
      { panelMembershipIds: body.panel_membership_ids, staffMembershipIds: body.staff_membership_ids, ownerTaxCode: body.owner_tax_code },
      scope.tenant.membershipId,
      (value) => this.cipher.blindIndex(tenantId, 'owner-identity', value),
      today,
      policy,
    );
    if (created) {
      await announce(scope, now, {
        action: 'vnd.independence_checked',
        resourceType: 'vendor_independence_check',
        resourceId: view.check.id,
        classification: CLASS.confidential,
        version: 1,
        eventType: 'vnd.independence.checked.v1',
        diff: { package_id: id, bidders: view.check.biddersCount, findings: view.check.findingsCount, strong: view.check.strongCount, gate_open: view.gate.open, policy_version: policy.version },
      });
    }
    // A run over the same facts and the same rule writes no new check, but the command is still audited: somebody asked.
    if (!created) await scope.audit({ action: 'vnd.independence_rechecked', resourceType: 'vendor_independence_check', resourceId: view.check.id, classification: CLASS.confidential, diff: { package_id: id, policy_version: policy.version } });
    return commandResult(scope, created ? 'CHECKED' : 'UNCHANGED', 1, view.check.id);
  }

  @Post('vendor/independence-findings/:id/decide')
  @HttpCode(200)
  @OperationId('decideVendorIndependenceFinding')
  @Command({ operation: 'decideVendorIndependenceFinding', versioned: true })
  async decide(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['VendorIndependenceDecision']): Promise<CommandResult> {
    this.require(access, PERMISSIONS.decideVendorIndependenceFinding);
    const row = await this.independence.decide(scope.tx, id, this.version(scope), body.decision, body.reason, scope.tenant.membershipId);
    await announce(scope, new Date(), {
      action: 'vnd.independence_decided',
      resourceType: 'vendor_independence_finding',
      resourceId: id,
      classification: CLASS.confidential,
      version: row.version,
      eventType: 'vnd.independence.decided.v1',
      reason: body.reason,
      diff: { package_id: row.packageId, kind: row.kind, strength: row.strength, decision: body.decision, parties: row.parties.map((party) => ({ kind: party.kind, id: party.id })) },
    });
    return commandResult(scope, body.decision, row.version, id);
  }

  @Post('vendor/contractors/:id/financial-periods')
  @HttpCode(200)
  @OperationId('recordVendorFinancialPeriod')
  @Command({ operation: 'recordVendorFinancialPeriod' })
  async recordPeriod(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['VendorFinancialPeriodNew']): Promise<CommandResult> {
    this.require(access, PERMISSIONS.recordVendorFinancialPeriod);
    const row = await this.finance.record(
      scope.tx,
      id,
      {
        fiscalYear: body.fiscal_year,
        revenue: body.revenue,
        totalAssets: body.total_assets,
        currentAssets: body.current_assets,
        currentLiabilities: body.current_liabilities,
        totalDebt: body.total_debt,
        equity: body.equity,
        ebit: body.ebit,
        interestExpense: body.interest_expense,
        documentId: body.document_id,
      },
      scope.tenant.membershipId,
    );
    await announce(scope, new Date(), { action: 'vnd.financial_period_recorded', resourceType: 'vendor_financial_period', resourceId: row.id, classification: CLASS.confidential, version: row.version, eventType: 'vnd.financial_period.recorded.v1', diff: { contractor_id: id, fiscal_year: row.year } });
    return commandResult(scope, 'CREATED', row.version, row.id);
  }

  @Post('vendor/financial-periods/:id/verify')
  @HttpCode(200)
  @OperationId('verifyVendorFinancialPeriod')
  @Command({ operation: 'verifyVendorFinancialPeriod', versioned: true })
  async verifyPeriod(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    this.require(access, PERMISSIONS.verifyVendorFinancialPeriod);
    const row = await this.finance.verify(scope.tx, id, this.version(scope), scope.tenant.membershipId);
    await announce(scope, new Date(), { action: 'vnd.financial_period_verified', resourceType: 'vendor_financial_period', resourceId: id, classification: CLASS.confidential, version: row.version, eventType: 'vnd.financial_period.verified.v1', diff: { contractor_id: row.contractorId, fiscal_year: row.year } });
    return commandResult(scope, 'VERIFIED', row.version, id);
  }

  @Post('vendor/packages/:id/controls')
  @HttpCode(200)
  @OperationId('setVendorPackageControls')
  @Command({ operation: 'setVendorPackageControls', versioned: true })
  async setControls(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['VendorPackageControlsSet']): Promise<CommandResult> {
    this.require(access, PERMISSIONS.setVendorPackageControls);
    const row = await this.controls.set(
      scope.tx,
      id,
      { securityBaseAmount: body.security_base_amount, bidValidUntil: body.bid_valid_until, estimatedValue: body.estimated_value, durationMonths: body.duration_months },
      scope.tenant.membershipId,
      this.version(scope),
    );
    await announce(scope, new Date(), { action: 'vnd.package_controls_set', resourceType: 'vendor_package_control', resourceId: id, classification: CLASS.plain, version: row.version, eventType: 'vnd.package_controls.set.v1', diff: { package_id: id, has_security: row.securityBaseAmount !== null, has_bid_validity: row.bidValidUntil !== null } });
    return commandResult(scope, 'UPDATED', row.version, id);
  }
}
