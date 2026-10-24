import { Controller, Get, Inject, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { IssEscalationStore, IssIssueStore, TenantDatabase, issueScope } from '@machvon/db';
import type { BreachLine } from '@machvon/db';
import { DomainError } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';

const READ_PERMISSION = PERMISSIONS.listIssueSlaBreaches;
const LEVEL = /^[123]$/;

/** The line of the board of ISS-10. A guest contractor sees which issue is escalated and how far, not who answers for it or who accepted. */
function breachView(line: BreachLine, overdueDays: number | null, guest: boolean): Record<string, unknown> {
  return {
    escalation_id: line.id,
    issue_id: line.issueId,
    issue_code: line.issueCode,
    issue_title: guest ? null : line.issueTitle,
    issue_status: line.issueStatus,
    severity: line.severity,
    project_code: line.projectCode,
    owner_unit_name: line.ownerUnitName,
    level: line.level,
    trigger: line.trigger,
    target_unit: guest || line.targetUnitId === null ? null : { id: line.targetUnitId, name: line.targetUnitName },
    task_force: guest || line.taskForceId === null ? null : { id: line.taskForceId, code: line.taskForceCode, name: line.taskForceName },
    accept_due_at: line.dueAt,
    status: line.status,
    accepted_by: guest || line.acceptedBy === null ? null : { membership_id: line.acceptedBy },
    accepted_at: line.acceptedAt,
    created_at: line.createdAt,
    issue_due_at: line.issueDueAt,
    overdue_since: line.overdueSince,
    overdue_days: overdueDays,
    acceptable: line.acceptable,
  };
}

/**
 * The board of escalations (ISS-10, `listIssueSlaBreaches`): the open and accepted escalations of the issues that are not closed, newest first. The caller
 * sees the ones of the issues in their read scope and the ones addressed to them, a unit they answer for or a task force they belong to, because the
 * receiver of an escalation must see it. Each line says whether the caller may accept it now.
 */
@Controller('issues')
export class IssEscalationReadsController {
  private readonly escalations = new IssEscalationStore();
  private readonly issues = new IssIssueStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('sla-breaches')
  @OperationId('listIssueSlaBreaches')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('level') level?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    if (level !== undefined && (typeof level !== 'string' || !LEVEL.test(level))) throw new DomainError('VALIDATION_FAILED', 422, 'level');
    const request = parsePageRequest(limit, cursor);
    const now = new Date();
    const reads = issueScope(access, READ_PERMISSION, now, { reporter: tenant.membershipId });
    const { lines, overdue, guest } = await this.database.withTenant(tenant, async (tx) => {
      const found = await this.escalations.breaches(tx, { level: level === undefined ? undefined : Number(level), limit: request.limit + 1, after: request.after }, reads, access, now);
      const shown = found.slice(0, request.limit);
      return {
        lines: found,
        overdue: await this.issues.overdueDays(tx, shown.map((line) => ({ overdueSince: line.overdueSince, closedAt: null, calendarCode: line.calendarCode })), now),
        guest: await this.issues.isGuest(tx, tenant.membershipId),
      };
    });
    const shown = lines.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map((line, index) => breachView(line, overdue[index] ?? null, guest)),
      next_cursor: lines.length > request.limit && last !== undefined ? encodeCursor({ code: last.createdKey, id: last.id }) : null,
      as_of: now.toISOString(),
    };
  }
}
