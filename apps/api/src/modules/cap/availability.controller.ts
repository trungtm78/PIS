import { Controller, Get, Inject, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { CapAvailabilityStore, CapPlanReads, TenantDatabase, planReadScope } from '@machvon/db';
import type { Availability } from '@machvon/db';
import { DomainError, asUuid } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';

/** openapi.json CapAvailability: what is left of a line (or an appropriation) and where it stands against its availability policy. */
export function availabilityView(found: Availability): Record<string, unknown> {
  const { figures, thresholds, verdict } = found;
  return {
    ...(found.allocationLineId === null ? {} : { allocation_line_id: found.allocationLineId }),
    ...(found.appropriationId === null ? {} : { appropriation_id: found.appropriationId }),
    allocated_vnd: figures.allocatedVnd,
    reserved_vnd: figures.reservedVnd,
    committed_vnd: figures.committedVnd,
    disbursed_vnd: figures.disbursedVnd,
    ...(verdict === undefined ? {} : { available_vnd: verdict.availableVnd, consumption_pct: verdict.consumptionPct, avc_state: verdict.state }),
    ...(verdict?.reason === null || verdict === undefined ? {} : { avc_reason: verdict.reason }),
    ...(thresholds?.policyId === null || thresholds === undefined ? {} : { avc_policy_id: thresholds.policyId }),
    as_of: found.asOf.toISOString(),
  };
}

/**
 * What is left of the capital of a line or an appropriation (ST-CAP-005, BR-CAP-06): the figures, the policy that governs, and the share used with its state. A line is read in
 * the scope of the caller like every line (a line outside it does not exist for them); an appropriation, like the register of appropriations, by the permission.
 */
@Controller('capital')
export class CapitalAvailabilityController {
  private readonly availability = new CapAvailabilityStore();
  private readonly lines = new CapPlanReads();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('availability')
  @OperationId('getCapitalAvailability')
  async get(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('allocation_line_id') lineId?: unknown,
    @Query('appropriation_id') appropriationId?: unknown,
  ): Promise<Record<string, unknown>> {
    // Exactly one of the two names what is asked about.
    if ((lineId === undefined) === (appropriationId === undefined)) throw new DomainError('VALIDATION_FAILED', 422, lineId === undefined ? 'allocation_line_id' : 'appropriation_id');
    const line = lineId === undefined ? undefined : asUuid(String(lineId));
    const appropriation = appropriationId === undefined ? undefined : asUuid(String(appropriationId));
    if (lineId !== undefined && line === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'allocation_line_id');
    if (appropriationId !== undefined && appropriation === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'appropriation_id');
    const now = new Date();
    const found = await this.database.withTenant(tenant, async (tx) => {
      if (appropriation !== undefined) return this.availability.ofAppropriation(tx, appropriation);
      const visible = await this.lines.findLine(tx, line as string, planReadScope(access, PERMISSIONS.getCapitalAvailability, now));
      return visible === undefined ? undefined : this.availability.ofLine(tx, visible.id);
    });
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return availabilityView(found);
  }
}
