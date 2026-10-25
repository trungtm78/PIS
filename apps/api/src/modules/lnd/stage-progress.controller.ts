import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { LndLandSource, LndStageProgressStore, TenantDatabase } from '@machvon/db';
import type { ProgressOverview, StageLine } from '@machvon/db';
import { DomainError, asUuid, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { projectRefs, reaches } from './reach';

const REPORT_PERMISSION = PERMISSIONS.reportLandStageProgress;
const READ_PERMISSION = PERMISSIONS.getLandProgress;
const RESOURCE_TYPE = 'land_stage_progress';
const CLASSIFICATION = 'INTERNAL';

const idOf = (value: unknown, field: string): string => {
  const id = typeof value === 'string' ? asUuid(value) : undefined;
  if (id === undefined) throw new DomainError('VALIDATION_FAILED', 422, field);
  return id.toLowerCase();
};

/** A stage as the screen reads it: an allowlist of what a stage is, with the name of the unit that executes it and nothing that names a person. */
export function stageLineView(line: StageLine): Record<string, unknown> {
  return {
    id: line.id,
    project_id: line.projectId,
    section_id: line.sectionId,
    plan_id: line.planId,
    stage_code: line.stageCode,
    executor_kind: line.executorKind,
    executor_unit_id: line.executorUnitId,
    executor_unit_name: line.executorUnitName,
    mode: line.mode,
    planned_start: line.plannedStart,
    planned_end: line.plannedEnd,
    actual_start: line.actualStart,
    actual_end: line.actualEnd,
    parcels_total: line.parcelsTotal,
    parcels_done: line.parcelsDone,
    progress_pct: line.progressPct,
    last_reported_at: line.lastReportedAt,
    evidence_document_version_id: line.evidenceDocumentVersionId,
    status: line.status,
    blocker_issue_id: line.blockerIssueId,
    blocker_note: line.blockerNote,
    version: line.version,
  };
}

export function overviewView(overview: ProgressOverview, asOf: Date): Record<string, unknown> {
  const { totals } = overview;
  return {
    project_id: overview.projectId,
    as_of: asOf.toISOString(),
    totals: {
      sections: totals.sections,
      sections_handed_over: totals.sectionsHandedOver,
      required_area_m2: totals.requiredAreaM2,
      handed_area_m2: totals.handedAreaM2,
      parcels: totals.parcels,
      parcels_noticed: totals.parcelsNoticed,
      parcels_paid: totals.parcelsPaid,
      parcels_handed_over: totals.parcelsHandedOver,
      households: totals.households,
      plans_posted: totals.plansPosted,
      payments_paid: totals.paymentsPaid,
      payments_total: totals.paymentsTotal,
      late_stages: totals.lateStages,
    },
    parcels_by_status: overview.parcelsByStatus,
    sections: overview.sections.map((section) => ({
      id: section.id,
      code: section.code,
      name: section.name,
      status: section.status,
      required_area_m2: section.requiredAreaM2,
      handed_area_m2: section.handedAreaM2,
      target_date: section.targetDate,
      parcels: section.parcels,
      parcels_noticed: section.parcelsNoticed,
      parcels_paid: section.parcelsPaid,
      parcels_handed_over: section.parcelsHandedOver,
    })),
    stages: overview.stages.map(stageLineView),
  };
}

/**
 * The progress of land clearance by stage (ST-LND-010, LND-01, LND-11). A stage that the land fund centre or the board of the district executes is tracked from outside: the
 * executing unit reports parcels done with the evidence of a clean document, and the people of the project do the same and say who executes. The caller needs `land.progress.report`
 * over the project (its owner or investor units, the project or the tenant), or over the unit that was named executor of the stage by the project; the second reach is not enough to
 * give a stage to a unit. The overview of a project is read with `land.read`; a project outside the scope of the caller is not found.
 */
@Controller()
export class LandStageProgressController {
  private readonly source = new LndLandSource();
  private readonly stages = new LndStageProgressStore(this.source);

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Post('land-stage-progress/report')
  @HttpCode(200)
  @OperationId('reportLandStageProgress')
  @Command({ operation: 'reportLandStageProgress' })
  async report(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['LndReportLandStageProgress']): Promise<CommandResult> {
    const now = new Date();
    const projectId = idOf(body.project_id, 'project_id');
    const project = await this.source.projectRef(scope.tx, projectId);
    // A project of another tenant is indistinguishable from one that does not exist.
    if (project === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    let assignedOnly = false;
    if (!reaches(access, REPORT_PERMISSION, projectRefs(project), now)) {
      // Not the people of the project: the unit named as the executor may report, if the project gave it the stage.
      const unit = await this.source.unitRef(scope.tx, idOf(body.executor_unit_id, 'executor_unit_id'));
      if (unit === undefined || !reaches(access, REPORT_PERMISSION, [{ ownerUnitPath: unit.path, ownerUnitId: unit.id, projectId }], now)) throw new DomainError('SCOPE_DENIED', 403);
      assignedOnly = true;
    }
    const reported = await this.stages.report(
      scope.tx,
      {
        projectId,
        sectionId: body.section_id,
        planId: body.plan_id,
        stageCode: body.stage_code,
        executorKind: body.executor_kind,
        executorUnitId: body.executor_unit_id,
        mode: body.mode,
        parcelsTotal: body.parcels_total,
        parcelsDone: body.parcels_done,
        plannedStart: body.planned_start,
        plannedEnd: body.planned_end,
        actualStart: body.actual_start,
        actualEnd: body.actual_end,
        evidenceDocumentVersionId: body.evidence_document_version_id,
        blockerNote: body.blocker_note,
      },
      scope.tenant.membershipId,
      { today: vietnamDateOf(now), assignedOnly },
    );
    await scope.audit({
      action: 'land.stage_progress_reported',
      resourceType: RESOURCE_TYPE,
      resourceId: reported.id,
      classification: CLASSIFICATION,
      diff: {
        project_id: reported.projectId,
        section_id: reported.sectionId,
        stage_code: reported.stageCode,
        executor_kind: reported.executorKind,
        executor_unit_id: reported.executorUnitId,
        previous_executor_unit_id: reported.previousExecutorUnitId,
        from_status: reported.previousStatus,
        to_status: reported.status,
        parcels_total: reported.parcelsTotal,
        parcels_done: reported.parcelsDone,
        evidence_document_version_id: reported.evidenceDocumentVersionId,
        created: reported.created,
      },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: reported.id,
      aggregateVersion: reported.version,
      type: 'lnd.stage_progress.reported.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        stage_id: reported.id,
        project_id: reported.projectId,
        section_id: reported.sectionId,
        stage_code: reported.stageCode,
        executor_kind: reported.executorKind,
        mode: 'TRACKED_EXTERNAL',
        status: reported.status,
        parcels_total: reported.parcelsTotal,
        parcels_done: reported.parcelsDone,
        progress_pct: reported.progressPct,
        version: reported.version,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
      },
      eventKey: `${RESOURCE_TYPE}:${reported.id}:${reported.version}`,
    });
    // A stage that this report took into LATE asks ISS for its issue: once, because the stage left the other statuses once.
    if (reported.lateEvent !== null) await scope.emit(reported.lateEvent);
    return commandResult(scope, reported.status, reported.version, reported.id);
  }

  @Get('projects/:id/land-progress')
  @OperationId('getLandProgress')
  async progress(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id') id: string,
    @Query('section_id') section?: unknown,
  ): Promise<Record<string, unknown>> {
    const projectId = idOf(id, 'id');
    const sectionId = section === undefined ? undefined : idOf(section, 'section_id');
    const now = new Date();
    const overview = await this.database.withTenant(tenant, async (tx) => {
      const project = await this.source.projectRef(tx, projectId);
      // A project outside the scope of the caller is not found, as if it did not exist.
      if (project === undefined || !reaches(access, READ_PERMISSION, projectRefs(project), now)) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      if (sectionId !== undefined && (await this.source.sectionOfProject(tx, projectId, sectionId)) === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      return this.stages.overview(tx, projectId, sectionId);
    });
    return overviewView(overview, now);
  }
}
