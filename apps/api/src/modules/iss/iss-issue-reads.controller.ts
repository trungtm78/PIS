import { Controller, Get, Inject, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { IssEscalationStore, IssIssueStore, LAND_HOUSEHOLD_PERMISSION, TenantDatabase, issueScope } from '@machvon/db';
import { DomainError, effectivePermissions, holdsPermission } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { issueDetailView, issueEventView, issueLineView } from './issue-view';

const READ_PERMISSION = PERMISSIONS.get_resources_issue;
const ESCALATE_PERMISSION = PERMISSIONS.escalateIssue;

/**
 * The issues in the scope of the caller (ISS-01) and the workspace of one issue with its timeline (ISS-03): a DTO allowlist filtered by the
 * unit tree, the project and the contract of the caller's grants, and by the person who reported the issue. An issue outside the scope, or
 * of another tenant, does not exist for the caller (404). What a reader sees of an issue depends on who they are: staff or a guest
 * contractor, and whether they may read the households a land complaint names.
 */
@Controller('resources/issue')
export class IssIssueReadsController {
  private readonly issues = new IssIssueStore();
  private readonly escalations = new IssEscalationStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  @OperationId('get_resources_issue')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const request = parsePageRequest(limit, cursor);
    const now = new Date();
    const reads = issueScope(access, READ_PERMISSION, now, { reporter: tenant.membershipId });
    const { lines, overdue, guest } = await this.database.withTenant(tenant, async (tx) => {
      const found = await this.issues.list(tx, reads, { limit: request.limit + 1, after: request.after });
      const shown = found.slice(0, request.limit);
      return { lines: found, overdue: await this.issues.overdueDays(tx, shown, now), guest: await this.issues.isGuest(tx, tenant.membershipId) };
    });
    const shown = lines.slice(0, request.limit);
    const last = shown[shown.length - 1];
    const viewer = { membershipId: tenant.membershipId, guest };
    return {
      items: shown.map((line, index) => issueLineView(line, overdue[index] ?? null, viewer)),
      next_cursor: lines.length > request.limit && last !== undefined ? encodeCursor({ code: last.codeKey, id: last.id }) : null,
      as_of: now.toISOString(),
    };
  }

  /** The issue with its timeline, the oldest event first; `limit` and `cursor` page the timeline and `next_cursor` is the cursor of its next page. */
  @Get(':id')
  @OperationId('get_resources_issue_id')
  async get(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<Record<string, unknown>> {
    const request = parsePageRequest(limit, cursor);
    const now = new Date();
    const reads = issueScope(access, READ_PERMISSION, now, { reporter: tenant.membershipId });
    const found = await this.database.withTenant(tenant, async (tx) => {
      const detail = await this.issues.find(tx, id, reads);
      if (detail === undefined) return undefined;
      const [overdue] = await this.issues.overdueDays(tx, [detail], now);
      const events = await this.issues.events(tx, id, { limit: request.limit + 1, after: request.after });
      const escalationRows = await this.escalations.forIssue(tx, id);
      // The task force that could be offered for a manual escalation to level 3 is told to a reader who may escalate.
      const mayEscalate = holdsPermission(effectivePermissions(access, now, detail.place), ESCALATE_PERMISSION);
      const taskForce = mayEscalate ? await this.escalations.activeTaskForceOf(tx, { projectId: detail.projectId, ownerUnitPath: detail.place.ownerUnitPath }, now) : undefined;
      return { detail, overdue: overdue ?? null, events, escalationRows, taskForce, guest: await this.issues.isGuest(tx, tenant.membershipId) };
    });
    // An issue in another tenant or outside the scope of the caller is indistinguishable from one that does not exist.
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const viewer = { membershipId: tenant.membershipId, guest: found.guest };
    const rights = { land: holdsPermission(effectivePermissions(access, now, found.detail.place), LAND_HOUSEHOLD_PERMISSION) };
    const shown = found.events.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      ...issueDetailView(found.detail, found.overdue, viewer, rights, { escalations: found.escalationRows, taskForce: found.taskForce }),
      events: shown.map((event) => issueEventView(event, viewer, rights, found.detail.sourceModule)),
      next_cursor: found.events.length > request.limit && last !== undefined ? encodeCursor({ code: last.createdAtKey, id: last.id }) : null,
      as_of: now.toISOString(),
    };
  }
}

