import { Controller, Get, Inject, Optional, Param, ParseUUIDPipe } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { DisReportStore, TenantDatabase, projectScope } from '@machvon/db';
import { DomainError } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { ReportApprovalFlow } from './report-approval.flow';
import { workflowView } from './report-workflow.view';
import { DIS_CLOCK } from './tokens';

const READ_PERMISSION = PERMISSIONS.getReportRevision;

/**
 * The steps of the approval of a weekly report (WF-1): which steps there are, where the report is, the deadline of each and who was given it. Readable by whoever may read the report; a report outside the scope of the
 * reader is not there (404). On the default definition the answer is the one step of the unit reviewer.
 */
@Controller()
export class ReportWorkflowReadsController {
  private readonly reports = new DisReportStore();
  private readonly flow = new ReportApprovalFlow();
  private readonly clock: () => Date;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Optional() @Inject(DIS_CLOCK) clock?: () => Date,
  ) {
    this.clock = clock ?? ((): Date => new Date());
  }

  @Get('reports/:id/workflow')
  @OperationId('getReportWorkflow')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = this.clock();
    const found = await this.database.withTenant(tenant, async (tx) => {
      const detail = await this.reports.find(tx, id.toLowerCase(), projectScope(access, READ_PERMISSION, now));
      if (detail === undefined) return undefined;
      const view = await this.flow.read(tx, detail.id, now);
      return workflowView({ ...view, report: detail.status, now });
    });
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return found;
  }
}
