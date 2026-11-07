import { Controller, Get, Inject, Param, ParseUUIDPipe } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { PayDisbursementCheck, TenantDatabase, projectScope } from '@machvon/db';
import { vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';

const READ_PERMISSION = PERMISSIONS.checkProjectDisbursement;

/**
 * The precondition of a disbursement as a read (governance deepening G1-2, PAY-19): whether a project may be paid and, when it may not, the cause (the stage of the project, or the approved amount it holds) and the
 * way to fix it. The commands that build and send a payment refuse with the same verdict; this read tells a person before the request is filled. The number on the system wins over paper.
 */
@Controller()
export class DisbursementCheckController {
  private readonly check = new PayDisbursementCheck();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('projects/:id/disbursement-check')
  @OperationId('checkProjectDisbursement')
  async verdict(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = new Date();
    const view = await this.database.withTenant(tenant, (tx) => this.check.check(tx, projectScope(access, READ_PERMISSION, now), id.toLowerCase(), vietnamDateOf(now)));
    return {
      project_id: view.projectId,
      project_code: view.projectCode,
      allowed: view.allowed,
      refusal: view.refusal,
      fix: view.fix,
      cause: { project_status: view.cause.projectStatus, allocated_vnd: view.cause.allocatedVnd },
      warnings: view.warnings,
      policy_version: view.policyVersion,
      as_of: view.asOf,
    };
  }
}
