import { Controller, Get, Inject, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { TenantDatabase, VendorPortalStore, VendorReconfirmationStore, VendorRemediationStore } from '@machvon/db';
import { DomainError, PORTAL_REQUEST_STATUSES, daysUntil } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { assertHoldsAnywhere, holdsAnywhere, portalEvaluationDto, portalPlanDto, portalReconfirmationDto, portalRequestDto } from './vendor-portal-view';
import { todayOf } from './vendor-view';

/**
 * The reads of the contractor portal (VND-16 to VND-19; docs/vendor-investigation.md section 5). The contractor is the one the guest membership of the caller is bound to (`VendorPortalStore.enter`), never a value of the path
 * or the query, and from there the database answers that contractor's rows only and none of the tables of the investigation: nothing here can show a red flag, a lead, a screening hit, a risk grade or another contractor.
 * A caller that is not a guest contractor is 403 `PORTAL_CONTRACTOR_REQUIRED`.
 */
@Controller()
export class PortalReadsController {
  private readonly portal = new VendorPortalStore();
  private readonly reconfirmations = new VendorReconfirmationStore();
  private readonly plans = new VendorRemediationStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('portal/me')
  @OperationId('getPortalHome')
  async home(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess): Promise<Record<string, unknown>> {
    assertHoldsAnywhere(access, PERMISSIONS.getPortalHome);
    const now = new Date();
    const today = todayOf(now);
    return this.database.withTenant(tenant, async (tx) => {
      const caller = await this.portal.enter(tx, tenant.membershipId);
      const profile = await this.portal.profile(tx, caller);
      const reconfirmation = await this.reconfirmations.current(tx, caller, today);
      const requests = await this.portal.listOwn(tx, caller, undefined, now);
      const held = await this.portal.ownQualifications(tx, caller, today);
      const plans = await this.plans.ownPlans(tx, caller, today);
      const evaluations = await this.portal.ownEvaluations(tx, caller);
      const open = requests.filter((row) => row.status === 'OPEN');
      return {
        profile,
        reconfirmation: portalReconfirmationDto(reconfirmation),
        counts: {
          open_requests: open.length,
          overdue_requests: open.filter((row) => row.clock === 'OVERDUE').length,
          certificates_expiring: held.qualifications.filter((row) => row.state === 'EXPIRING_FIRST' || row.state === 'EXPIRING_SECOND' || row.state === 'EXPIRED').length,
          open_plans: plans.filter((entry) => ['PROPOSED', 'AGREED', 'IN_PROGRESS'].includes(entry.plan.status)).length,
          evaluations: evaluations.length,
        },
        actions: {
          respond: holdsAnywhere(access, PERMISSIONS.respondPortalRequest),
          certificate: holdsAnywhere(access, PERMISSIONS.submitPortalQualification),
          reconfirm: holdsAnywhere(access, PERMISSIONS.confirmPortalReconfirmation),
          remediation: holdsAnywhere(access, PERMISSIONS.agreePortalRemediationPlan),
        },
        as_of: now.toISOString(),
      };
    });
  }

  @Get('portal/requests')
  @OperationId('listPortalRequests')
  async requests(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    assertHoldsAnywhere(access, PERMISSIONS.listPortalRequests);
    const status = query.status;
    if (status !== undefined && (typeof status !== 'string' || !(PORTAL_REQUEST_STATUSES as readonly string[]).includes(status))) throw new DomainError('VALIDATION_FAILED', 422, 'status');
    const now = new Date();
    return this.database.withTenant(tenant, async (tx) => {
      const caller = await this.portal.enter(tx, tenant.membershipId);
      const rows = await this.portal.listOwn(tx, caller, status, now);
      return { items: rows.map(portalRequestDto), as_of: now.toISOString() };
    });
  }

  @Get('portal/qualifications')
  @OperationId('listPortalQualifications')
  async qualifications(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess): Promise<Record<string, unknown>> {
    assertHoldsAnywhere(access, PERMISSIONS.listPortalQualifications);
    const now = new Date();
    const today = todayOf(now);
    return this.database.withTenant(tenant, async (tx) => {
      const caller = await this.portal.enter(tx, tenant.membershipId);
      const held = await this.portal.ownQualifications(tx, caller, today);
      return {
        qualifications: held.qualifications.map((row) => ({
          id: row.id,
          kind: row.kind,
          certificate_no: row.certificateNo,
          grade: row.grade,
          scope: row.scope,
          issuer: row.issuer,
          issued_on: row.issuedOn,
          expires_on: row.expiresOn,
          verified: row.verifiedAt !== null,
          revoked: row.revokedAt !== null,
          state: row.state,
          days_left: row.expiresOn === null ? null : daysUntil(today, row.expiresOn),
        })),
        key_staff: held.keyStaff.map((row) => ({
          id: row.id,
          staff_role: row.staffRole,
          person_name: row.personName,
          qualification_title: row.qualificationTitle,
          expires_on: row.expiresOn,
          verified: row.verifiedAt !== null,
          state: row.state,
          days_left: row.expiresOn === null ? null : daysUntil(today, row.expiresOn),
        })),
        as_of: now.toISOString(),
      };
    });
  }

  @Get('portal/evaluations')
  @OperationId('listPortalEvaluations')
  async evaluations(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess): Promise<Record<string, unknown>> {
    assertHoldsAnywhere(access, PERMISSIONS.listPortalEvaluations);
    const now = new Date();
    return this.database.withTenant(tenant, async (tx) => {
      const caller = await this.portal.enter(tx, tenant.membershipId);
      return { items: (await this.portal.ownEvaluations(tx, caller)).map(portalEvaluationDto), as_of: now.toISOString() };
    });
  }

  @Get('portal/remediation-plans')
  @OperationId('listPortalRemediationPlans')
  async remediation(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess): Promise<Record<string, unknown>> {
    assertHoldsAnywhere(access, PERMISSIONS.listPortalRemediationPlans);
    const now = new Date();
    return this.database.withTenant(tenant, async (tx) => {
      const caller = await this.portal.enter(tx, tenant.membershipId);
      const plans = await this.plans.ownPlans(tx, caller, todayOf(now));
      return { items: plans.map((entry) => portalPlanDto(entry.plan, entry.actions)), as_of: now.toISOString() };
    });
  }
}
