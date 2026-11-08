import { Controller, Get, Inject, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { BidWorkflowReads, TenantDatabase, VendorDisputeStore, VendorOcdsReader, VendorPortalPolicyReader, VendorPortalStore, VendorReconfirmationStore, VendorRemediationStore } from '@machvon/db';
import { DomainError, PORTAL_REQUEST_KINDS, PORTAL_REQUEST_STATUSES, REMEDIATION_STATUSES } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { holdsOnWholeTenant } from '../adm/tenant-authority';
import { disputesDto, planEventDto, planLineDto, actionLineDto, reconfirmationLineDto, requestLineDto } from './vendor-portal-view';
import { policyDto, todayOf } from './vendor-view';

const RECONFIRM_STATES = ['NEVER', 'CURRENT', 'DUE_SOON', 'OVERDUE', 'LAPSED'] as const;

function word(value: unknown, field: string, allowed: readonly string[]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !allowed.includes(value)) throw new DomainError('VALIDATION_FAILED', 422, field);
  return value;
}

function uuid(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new DomainError('VALIDATION_FAILED', 422, field);
  return value.toLowerCase();
}

const pct = (part: number, whole: number): number | null => (whole === 0 ? null : Math.round((part * 1000) / whole) / 10);

/**
 * The reads of the staff side of the contractor portal, the plans of remediation, the disputes and the export of parties (VND-20 to VND-22; docs/vendor-investigation.md sections 5 to 8). A register of contractors belongs to the
 * whole tenant, so every read is judged on a grant over the whole tenant; every figure carries the rule it rests on, with its version, formula, source and legal status.
 */
@Controller()
export class VendorPortalStaffReadsController {
  private readonly requests = new VendorPortalStore();
  private readonly reconfirmations = new VendorReconfirmationStore();
  private readonly plans = new VendorRemediationStore();
  private readonly disputes = new VendorDisputeStore();
  private readonly ocds = new VendorOcdsReader();
  private readonly policies = new VendorPortalPolicyReader();
  private readonly people = new BidWorkflowReads();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  private require(access: EffectiveAccess, permission: string): void {
    if (!holdsOnWholeTenant(access, permission)) throw new DomainError('SCOPE_DENIED', 403);
  }

  @Get('vendor/portal/requests')
  @OperationId('listVendorPortalRequests')
  async listRequests(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.require(access, PERMISSIONS.listVendorPortalRequests);
    const status = word(query.status, 'status', PORTAL_REQUEST_STATUSES);
    const kind = word(query.kind, 'kind', PORTAL_REQUEST_KINDS);
    const contractorId = uuid(query.contractor_id, 'contractor_id');
    const now = new Date();
    const today = todayOf(now);
    return this.database.withTenant(tenant, async (tx) => {
      const rows = await this.requests.list(tx, { status, kind, contractorId, limit: 300 }, now);
      const figures = await this.requests.figures(tx, now);
      const clocks = await this.policies.clocks(tx, today);
      const names = await this.people.names(tx, rows.map((row) => row.requestedBy));
      return {
        items: rows.map((row) => requestLineDto(row, names)),
        counts: { open: figures.open, responded: figures.responded, overdue: figures.overdueOpen },
        in_time_pct: pct(figures.answeredInTime, figures.answeredInTime + figures.answeredLate + figures.overdueOpen),
        policies: Object.fromEntries(Object.entries(clocks).map(([code, policy]) => [code, policyDto(`VENDOR_PORTAL:${code}`, policy)])),
        as_of: now.toISOString(),
      };
    });
  }

  @Get('vendor/reconfirmations')
  @OperationId('listVendorReconfirmations')
  async listReconfirmations(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.require(access, PERMISSIONS.listVendorReconfirmations);
    const state = word(query.state, 'state', RECONFIRM_STATES);
    const now = new Date();
    return this.database.withTenant(tenant, async (tx) => {
      const found = await this.reconfirmations.list(tx, { state: state as (typeof RECONFIRM_STATES)[number] | undefined }, todayOf(now));
      return {
        items: found.items.map(reconfirmationLineDto),
        counts: { current: found.counts.current, due_soon: found.counts.dueSoon, overdue: found.counts.overdue, lapsed: found.counts.lapsed, never: found.counts.never },
        current_pct: found.currentPct,
        policy: policyDto('VENDOR_RECONFIRMATION', { ...found.policy, value: { interval_months: found.policy.value.interval_months, remind_days: found.policy.value.remind_days, grace_days: found.policy.value.grace_days, declaration_version: found.policy.value.declaration_version } }),
        as_of: now.toISOString(),
      };
    });
  }

  @Get('vendor/remediation-plans')
  @OperationId('listVendorRemediationPlans')
  async listPlans(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.require(access, PERMISSIONS.listVendorRemediationPlans);
    const status = word(query.status, 'status', REMEDIATION_STATUSES);
    const contractorId = uuid(query.contractor_id, 'contractor_id');
    const now = new Date();
    const today = todayOf(now);
    return this.database.withTenant(tenant, async (tx) => {
      const rows = await this.plans.listPlans(tx, { status, contractorId }, today);
      const names = await this.people.names(tx, rows.map((row) => row.proposedBy));
      return { items: rows.map((row) => planLineDto(row, names)), policy: policyDto('VENDOR_REMEDIATION', await this.policies.remediation(tx, today)), as_of: now.toISOString() };
    });
  }

  @Get('vendor/remediation-plans/:id')
  @OperationId('getVendorRemediationPlan')
  async getPlan(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    this.require(access, PERMISSIONS.getVendorRemediationPlan);
    const now = new Date();
    const today = todayOf(now);
    return this.database.withTenant(tenant, async (tx) => {
      const plan = await this.plans.findPlan(tx, id, today);
      if (plan === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      const actions = await this.plans.actions(tx, id, today);
      const events = await this.plans.events(tx, id);
      const names = await this.people.names(tx, [plan.proposedBy, plan.agreedBy ?? plan.proposedBy, ...actions.flatMap((action) => [action.doneBy ?? plan.proposedBy, action.verifiedBy ?? plan.proposedBy]), ...events.map((event) => event.actorId)]);
      return {
        plan: planLineDto(plan, names),
        actions: actions.map((action) => actionLineDto(action, names)),
        events: events.map((event) => planEventDto(event, names)),
        policy: policyDto('VENDOR_REMEDIATION', await this.policies.remediation(tx, today)),
        may_start: plan.status === 'AGREED',
        may_complete: plan.status === 'IN_PROGRESS' && actions.length > 0 && actions.every((action) => action.status === 'VERIFIED'),
        may_close: plan.status === 'PROPOSED' || plan.status === 'AGREED' || plan.status === 'IN_PROGRESS',
        as_of: now.toISOString(),
      };
    });
  }

  @Get('vendor/disputes')
  @OperationId('getVendorDisputes')
  async getDisputes(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.require(access, PERMISSIONS.getVendorDisputes);
    const contractorId = uuid(query.contractor_id, 'contractor_id');
    const now = new Date();
    return this.database.withTenant(tenant, async (tx) => disputesDto(await this.disputes.report(tx, contractorId), now.toISOString()));
  }

  @Get('vendor/ocds/parties')
  @OperationId('exportVendorOcdsParties')
  async exportParties(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.require(access, PERMISSIONS.exportVendorOcdsParties);
    const contractorId = uuid(query.contractor_id, 'contractor_id');
    const packageId = uuid(query.package_id, 'package_id');
    const now = new Date();
    return this.database.withTenant(tenant, async (tx) => {
      const found = await this.ocds.parties(tx, { contractorId, packageId }, todayOf(now));
      return {
        parties: found.parties,
        policy: policyDto('VENDOR_OCDS_EXPORT', found.policy),
        owners_included: found.policy.value.include_owners,
        contact_included: found.policy.value.include_contact,
        notice: 'Parties for review before publication: the legal basis for publishing beneficial owners and contact points is not confirmed, so both stay off unless the rule VENDOR_OCDS_EXPORT switches them on.',
        as_of: now.toISOString(),
      };
    });
  }
}
