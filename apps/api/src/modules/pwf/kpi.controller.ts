import { Controller, Get, Inject, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { PwfKpiStore, TenantDatabase, kpiOperations, projectScope } from '@machvon/db';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';

/**
 * The catalogue of the operations a KPI of a workflow can be (the closed list of the kernel, `getKpiOperations`) and the results of the KPIs of one task with what each was computed from (`listTaskKpiResults`, the "i" of a
 * figure). A task is read in the scope of `pwf.read`: a task out of it is not there. The results of a task are the facts of the task, not the score of a person.
 */
@Controller()
export class PwfKpiReadsController {
  private readonly kpis = new PwfKpiStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('pwf/kpi-operations')
  @OperationId('getKpiOperations')
  async operations(): Promise<Schemas['PwfKpiOperationList']> {
    return {
      items: kpiOperations().map((one) => ({ code: one.code, unit: one.unit, good_direction: one.goodDirection, required_facts: one.requiredFacts, params: one.params })),
      as_of: new Date().toISOString(),
    } as unknown as Schemas['PwfKpiOperationList'];
  }

  @Get('project-tasks/:task_id/kpi-results')
  @OperationId('listTaskKpiResults')
  async results(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('task_id', ParseUUIDPipe) taskId: string, @Query() query: Record<string, unknown>): Promise<Schemas['PwfKpiResultPage']> {
    const now = new Date();
    const page = parsePageRequest(query.limit, query.cursor);
    const found = await this.database.withTenant(tenant, (tx) => this.kpis.list(tx, projectScope(access, PERMISSIONS.listTaskKpiResults, now), taskId.toLowerCase(), { limit: page.limit, after: page.after }));
    return {
      items: found.items.map((one) => ({
        id: one.id,
        kpi_code: one.kpiCode,
        operation: one.operation,
        kpi_set_rule_id: one.kpiSetRuleId,
        kpi_set_version: one.kpiSetVersion,
        state: one.state,
        value: one.value,
        score: one.score,
        weight: one.weight,
        inputs_hash: one.inputsHash,
        inputs: one.inputs,
        computed_at: one.computedAt,
        supersedes_id: one.supersedesId,
      })),
      next_cursor: found.next === null ? null : encodeCursor(found.next),
      as_of: now.toISOString(),
    } as unknown as Schemas['PwfKpiResultPage'];
  }
}
