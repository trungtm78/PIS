import { Controller, Get, Inject, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { TenantDatabase, VendorFinanceStore, VendorIndependenceStore, VendorPackageControlStore, VendorPolicyReader } from '@machvon/db';
import { DomainError } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { holdsOnWholeTenant } from '../adm/tenant-authority';
import { checkDto, controlsDto, findingDto, gateDto, interestDto, periodDto } from './vendor-independence-view';
import { policyDto, todayOf } from './vendor-view';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidParam(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !UUID.test(value)) throw new DomainError('VALIDATION_FAILED', 422, field);
  return value;
}

function flagParam(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value !== 'true' && value !== 'false') throw new DomainError('VALIDATION_FAILED', 422, field);
  return value === 'true';
}

/**
 * The reads of the independence of the bidders of a package and of the finance and the load of a contractor (VND-07, VND-08; docs/vendor-controls-independence-finance.md). Every read is judged on a grant over the
 * whole tenant; every figure carries the rule it rests on, with its version, formula, source and legal status (unverified until the legal staff of the tenant confirm it). The declarations of interest and the findings are
 * personal data of staff and are read with `vnd.independence.read` only. A read never writes.
 */
@Controller()
export class VendorIndependenceReadsController {
  private readonly independence = new VendorIndependenceStore();
  private readonly finance = new VendorFinanceStore();
  private readonly controls = new VendorPackageControlStore();
  private readonly policies = new VendorPolicyReader();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  private require(access: EffectiveAccess, permission: string): void {
    if (!holdsOnWholeTenant(access, permission)) throw new DomainError('SCOPE_DENIED', 403);
  }

  @Get('vendor/person-interests')
  @OperationId('listVendorPersonInterests')
  async interests(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.require(access, PERMISSIONS.listVendorPersonInterests);
    const membershipId = uuidParam(query.membership_id, 'membership_id');
    const activeOnly = flagParam(query.active_only, 'active_only');
    return this.database.withTenant(tenant, async (tx) => ({ items: (await this.independence.interests(tx, { membershipId, activeOnly })).map(interestDto), as_of: new Date().toISOString() }));
  }

  @Get('vendor/packages/:id/independence')
  @OperationId('getVendorIndependence')
  async independenceOf(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    this.require(access, PERMISSIONS.getVendorIndependence);
    const now = new Date();
    const mayDecide = holdsOnWholeTenant(access, PERMISSIONS.decideVendorIndependenceFinding);
    return this.database.withTenant(tenant, async (tx) => {
      await this.controls.get(tx, id);
      const policy = await this.policies.independence(tx, todayOf(now));
      const view = await this.independence.latest(tx, id, policy);
      return {
        package_id: id,
        check: view === undefined ? null : checkDto(view.check),
        findings: view === undefined ? [] : view.findings.map((one) => findingDto(one, { membershipId: tenant.membershipId, mayDecide }, view.check.runBy)),
        gate: gateDto(view?.gate),
        policy: policyDto('VENDOR_INDEPENDENCE', policy),
        as_of: now.toISOString(),
      };
    });
  }

  @Get('vendor/packages/:id/controls')
  @OperationId('getVendorPackageControls')
  async packageControls(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    this.require(access, PERMISSIONS.getVendorPackageControls);
    return this.database.withTenant(tenant, async (tx) => controlsDto(await this.controls.get(tx, id)));
  }

  @Get('vendor/contractors/:id/finance')
  @OperationId('getVendorFinance')
  async financeOf(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.require(access, PERMISSIONS.getVendorFinance);
    const packageId = uuidParam(query.package_id, 'package_id');
    const now = new Date();
    return this.database.withTenant(tenant, async (tx) => {
      const policy = await this.policies.finance(tx, todayOf(now));
      const reading = await this.finance.assessFor(tx, id, packageId, policy);
      const { assessment } = reading;
      return {
        contractor_id: id,
        periods: reading.periods.map(periodDto),
        overall: assessment.overall,
        verified_years: assessment.verifiedYears,
        average_revenue: assessment.averageRevenue,
        required_revenue: assessment.requiredRevenue,
        results: assessment.results.map((one) => ({ test: one.test, status: one.status, value: one.value, threshold: one.threshold, year: one.year })),
        requirement:
          reading.requirement === null ? null : { package_id: reading.requirement.packageId, package_value: reading.requirement.packageValue, duration_months: reading.requirement.durationMonths, value_from: reading.requirement.valueFrom },
        policy: policyDto('VENDOR_FINANCE', policy),
        as_of: now.toISOString(),
      };
    });
  }

  @Get('vendor/contractors/:id/capacity')
  @OperationId('getVendorCapacity')
  async capacityOf(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    this.require(access, PERMISSIONS.getVendorCapacity);
    const now = new Date();
    const today = todayOf(now);
    return this.database.withTenant(tenant, async (tx) => {
      const financePolicy = await this.policies.finance(tx, today);
      const capacityPolicy = await this.policies.capacity(tx, today);
      const { facts, assessment } = await this.finance.capacity(tx, id, today, financePolicy, capacityPolicy);
      return {
        contractor_id: id,
        facts: {
          open_contract_value: facts.openContractValue,
          open_contract_count: facts.openContractCount,
          late_contract_count: facts.lateContractCount,
          pending_award_value: facts.pendingAwardValue,
          pending_award_count: facts.pendingAwardCount,
          average_annual_revenue: facts.averageAnnualRevenue,
        },
        load: assessment.load,
        load_multiple: assessment.loadMultiple,
        limit_multiple: assessment.limitMultiple,
        signals: assessment.signals,
        status: assessment.status,
        capacity_policy: policyDto('VENDOR_CAPACITY', capacityPolicy),
        finance_policy: policyDto('VENDOR_FINANCE', financePolicy),
        as_of: now.toISOString(),
      };
    });
  }
}
