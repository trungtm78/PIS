import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { COMPLAINT_FILED_EVENT, LndComplaintStore, LndLandSource, TenantDatabase, complaintFiledPayload, householdScopeUnits } from '@machvon/db';
import type { ComplaintLine, TenantTx } from '@machvon/db';
import { DomainError, asUuid, daysBetween, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { projectRefs, reaches } from './reach';

const FILE_PERMISSION = PERMISSIONS.fileLandComplaint;
const RESOLVE_PERMISSION = PERMISSIONS.resolveLandComplaint;
const READ_PERMISSION = PERMISSIONS.listLandComplaints;
const RESOURCE_TYPE = 'land_complaint';
/** What the complainant says is personal data: the trail of a complaint is classified so, and carries the number, the subject and the dates, never the words or the household. */
const CLASSIFICATION = 'PERSONAL';
const OPEN_STATUSES: readonly string[] = ['RECEIVED', 'UNDER_REVIEW'];

/** A complaint as the board reads it: an allowlist of what a complaint is; the days left only for a complaint that waits for an answer. */
export function complaintLineView(line: ComplaintLine, today: string): Record<string, unknown> {
  return {
    id: line.id,
    project_id: line.projectId,
    household_id: line.householdId,
    household_code: line.householdCode,
    plan_id: line.planId,
    owner_unit_id: line.ownerUnitId,
    complaint_no: line.complaintNo,
    filed_on: line.filedOn,
    channel: line.channel,
    subject: line.subject,
    description: line.description,
    status: line.status,
    due_on: line.dueOn,
    remaining_days: OPEN_STATUSES.includes(line.status) ? daysBetween(today, line.dueOn) : null,
    resolved_on: line.resolvedOn,
    resolution_note: line.resolutionNote,
    resolution_document_version_id: line.resolutionDocumentVersionId,
    issue_id: line.issueId,
    version: line.version,
  };
}

/**
 * The complaints of the households about the clearance of their land (ST-LND-008, LND 3.3, UAT-AC384). The right to file is `land.complaint.write` and the right to answer `land.complaint.resolve`, both over the
 * project and inside the units of the household (a grant on a project reaches no household). The trail and the events carry the number of the complaint, its subject and its dates, never the words of the
 * complainant or the household; the event that asks ISS for an issue holds the number and the ids and nothing else, so the issue holds only a reference code.
 */
@Controller()
export class LandComplaintController {
  private readonly source = new LndLandSource();
  private readonly complaints = new LndComplaintStore(undefined, this.source);

  @Post('land-complaints')
  @HttpCode(200)
  @OperationId('fileLandComplaint')
  @Command({ operation: 'fileLandComplaint' })
  async file(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['LndFileLandComplaint']): Promise<CommandResult> {
    const now = new Date();
    await this.mayAct(scope.tx, access, body.project_id.toLowerCase(), FILE_PERMISSION, now);
    const units = await householdScopeUnits(scope.tx, access, FILE_PERMISSION, now);
    const done = await this.complaints.file(
      scope.tx,
      { projectId: body.project_id, householdId: body.household_id, planId: body.plan_id, ownerUnitId: body.owner_unit_id, channel: body.channel, subject: body.subject, description: body.description, filedOn: body.filed_on },
      scope.tenant.membershipId,
      units,
      vietnamDateOf(now),
    );
    await scope.audit({
      action: 'lnd.complaint_filed',
      resourceType: RESOURCE_TYPE,
      resourceId: done.id,
      classification: CLASSIFICATION,
      diff: {
        project_id: done.projectId,
        complaint_no: done.complaintNo,
        subject: done.subject,
        channel: done.channel,
        filed_on: done.filedOn,
        due_on: done.dueOn,
        days_applied: done.daysApplied,
        deadline_id: done.deadlineId,
        rule_version_id: done.ruleVersionId,
        rule_revision: done.ruleRevision,
        parcels_held: done.parcelsHeld,
      },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: done.id,
      aggregateVersion: done.version,
      type: COMPLAINT_FILED_EVENT,
      schemaVersion: 1,
      payload: { ...complaintFiledPayload(done, scope.tenant.tenantId, now), actor_id: scope.tenant.membershipId },
      eventKey: `${RESOURCE_TYPE}:${done.id}:${done.version}`,
    });
    return commandResult(scope, 'RECEIVED', done.version, done.id);
  }

  @Post('land-complaints/:id/resolve')
  @HttpCode(200)
  @OperationId('resolveLandComplaint')
  @Command({ operation: 'resolveLandComplaint', versioned: true })
  async resolve(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['LndResolveLandComplaint'],
  ): Promise<CommandResult> {
    const now = new Date();
    const units = await householdScopeUnits(scope.tx, access, RESOLVE_PERMISSION, now);
    const place = await this.complaints.place(scope.tx, id, units);
    if (place === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    await this.mayAct(scope.tx, access, place.projectId, RESOLVE_PERMISSION, now);
    const done = await this.complaints.resolve(
      scope.tx,
      { complaintId: id, expectedVersion: scope.expectedVersion ?? 0, outcome: body.outcome, resolutionDocumentVersionId: body.resolution_document_version_id, resolvedOn: body.resolved_on, note: body.note },
      scope.tenant.membershipId,
      units,
      vietnamDateOf(now),
    );
    await scope.audit({
      action: 'lnd.complaint_resolved',
      resourceType: RESOURCE_TYPE,
      resourceId: done.id,
      classification: CLASSIFICATION,
      diff: {
        project_id: done.projectId,
        complaint_no: done.complaintNo,
        outcome: done.status,
        from_status: done.fromStatus,
        resolved_on: done.resolvedOn,
        due_on: done.dueOn,
        late_days: done.lateDays,
        resolution_document_version_id: done.resolutionDocumentVersionId,
        parcels_released: done.parcelsReleased,
      },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: done.id,
      aggregateVersion: done.version,
      type: 'lnd.complaint.resolved.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        complaint_id: done.id,
        reference_code: done.complaintNo,
        project_id: done.projectId,
        status: done.status,
        resolved_on: done.resolvedOn,
        late_days: done.lateDays,
        version: done.version,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
      },
      eventKey: `${RESOURCE_TYPE}:${done.id}:${done.version}`,
    });
    return commandResult(scope, done.status, done.version, done.id);
  }

  /** The project has to exist for the caller (they reach it with a right to read or to act) and they need the right asked for: a project they cannot see is 404, one they see and may not act on is 403. */
  private async mayAct(tx: TenantTx, access: EffectiveAccess, projectId: string, permission: string, now: Date): Promise<void> {
    const project = await this.source.projectRef(tx, projectId);
    const refs = project === undefined ? [] : projectRefs(project);
    if (project === undefined || ![permission, READ_PERMISSION].some((seeing) => reaches(access, seeing, refs, now))) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (!reaches(access, permission, refs, now)) throw new DomainError('SCOPE_DENIED', 403);
  }
}

/** The complaints of a project (LND-08) inside the units of the reader. */
@Controller()
export class LandComplaintReadsController {
  private readonly source = new LndLandSource();
  private readonly complaints = new LndComplaintStore(undefined, this.source);

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('land-complaints')
  @OperationId('listLandComplaints')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('project_id') project?: unknown,
    @Query('status') status?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const projectId = typeof project === 'string' ? asUuid(project) : undefined;
    if (projectId === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'project_id');
    const request = parsePageRequest(limit, cursor);
    const now = new Date();
    const rows = await this.database.withTenant(tenant, async (tx) => {
      // A project the caller cannot reach has no complaints for them.
      const place = await this.source.projectRef(tx, projectId.toLowerCase());
      if (place === undefined || !reaches(access, READ_PERMISSION, projectRefs(place), now)) return [];
      return this.complaints.list(tx, { projectId, status: typeof status === 'string' ? status : undefined, limit: request.limit + 1, after: request.after }, await householdScopeUnits(tx, access, READ_PERMISSION, now));
    });
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    const today = vietnamDateOf(now);
    return {
      items: shown.map((line) => complaintLineView(line, today)),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.complaintNo, id: last.id }) : null,
      as_of: now.toISOString(),
    };
  }
}
