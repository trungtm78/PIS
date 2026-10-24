import { Controller, Get, Inject, Query } from '@nestjs/common';
import { PrjAccountabilityStore, PrjTaskForceStore, TenantDatabase, projectScope, taskForceScope } from '@machvon/db';
import type { AssignmentFilter, AssignmentLine, TaskForceLine, TaskForceStatus } from '@machvon/db';
import { DomainError, asUuid, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';

const ASSIGNMENT_READ_PERMISSION = 'project.read';
const TASK_FORCE_READ_PERMISSION = 'taskforce.read';

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/** The text of a query parameter, or undefined when it is absent; a parameter that is repeated or not text is a fault of the request. */
function queryText(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value === '') throw invalid(name);
  return value;
}

/** The line of the register of assignments (PRJ-17) as the contract exposes it: an allowlist, so a column added to the table later is not shown until it is listed here. */
export function assignmentLineView(line: AssignmentLine): Record<string, unknown> {
  return {
    id: line.id,
    project_id: line.projectId,
    project_code: line.projectCode,
    project_name: line.projectName,
    leader: { membership_id: line.leader.membershipId, display_name: line.leader.displayName },
    accountability_role: line.role,
    assignment_document_id: line.assignmentDocumentId,
    valid_from: line.validFrom,
    valid_until: line.validUntil,
    status: line.status,
    end_reason: line.endReason,
    version: line.version,
  };
}

/** The task force (PRJ-18) with its terms: an allowlist as well. */
export function taskForceLineView(line: TaskForceLine): Record<string, unknown> {
  return {
    id: line.id,
    code: line.code,
    name: line.name,
    purpose: line.purpose,
    lead: { membership_id: line.lead.membershipId, display_name: line.lead.displayName },
    scope_unit: { id: line.scopeUnit.id, code: line.scopeUnit.code, name: line.scopeUnit.name },
    establishment_document_id: line.establishmentDocumentId,
    valid_from: line.validFrom,
    valid_until: line.validUntil,
    status: line.status,
    version: line.version,
    members: line.members.map((member) => ({
      id: member.id,
      membership_id: member.membershipId,
      display_name: member.displayName,
      role: member.role,
      project: member.project,
      valid_from: member.validFrom,
      valid_until: member.validUntil,
    })),
  };
}

/**
 * The reads of PRJ-17 and PRJ-18 (ST-PRJ-005): the assignments of the projects the caller may read, and the task forces whose scope unit lies in a
 * subtree the caller may read. Both are filtered by the tree of organisation units before the page is cut.
 */
@Controller()
export class AccountabilityReadsController {
  private readonly accountability = new PrjAccountabilityStore();
  private readonly forces = new PrjTaskForceStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('resources/project_accountability')
  @OperationId('get_resources_project_accountability')
  async assignments(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('project_id') projectId?: unknown,
    @Query('status') status?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const request = parsePageRequest(limit, cursor);
    const project = queryText(projectId, 'project_id');
    const filter: AssignmentFilter = {};
    if (project !== undefined) {
      const id = asUuid(project);
      if (id === undefined) throw invalid('project_id');
      filter.projectId = id;
    }
    const state = queryText(status, 'status');
    if (state !== undefined) {
      if (state !== 'ACTIVE' && state !== 'ENDED') throw invalid('status');
      filter.status = state;
    }
    const now = new Date();
    const lines = await this.database.withTenant(tenant, (tx) =>
      this.accountability.list(tx, projectScope(access, ASSIGNMENT_READ_PERMISSION, now), filter, { limit: request.limit + 1, after: request.after }),
    );
    const shown = lines.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map(assignmentLineView),
      next_cursor: lines.length > request.limit && last !== undefined ? encodeCursor({ code: last.codeKey, id: last.id }) : null,
      as_of: vietnamDateOf(now),
    };
  }

  @Get('resources/task_force')
  @OperationId('get_resources_task_force')
  async taskForces(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('status') status?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const request = parsePageRequest(limit, cursor);
    const state = queryText(status, 'status');
    if (state !== undefined && state !== 'ACTIVE' && state !== 'DISSOLVED') throw invalid('status');
    const now = new Date();
    const lines = await this.database.withTenant(tenant, (tx) =>
      this.forces.list(tx, taskForceScope(access, TASK_FORCE_READ_PERMISSION, now), { status: state as TaskForceStatus | undefined }, { limit: request.limit + 1, after: request.after }),
    );
    const shown = lines.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map(taskForceLineView),
      next_cursor: lines.length > request.limit && last !== undefined ? encodeCursor({ code: last.codeKey, id: last.id }) : null,
      as_of: vietnamDateOf(now),
    };
  }
}
