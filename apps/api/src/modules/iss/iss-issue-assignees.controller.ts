import { Controller, Get, Inject, Param, ParseUUIDPipe } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { IssIssueStore, TenantDatabase, issueScope } from '@machvon/db';
import { DomainError } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';

/**
 * The people an issue may be given to (ISS-03, CR-ISS-14): the active members who hold `issue.work` over the place of the issue, which is
 * exactly who `assignIssue` accepts. The right to assign is the right to see them, so the screen needs no read of the member directory.
 * An issue outside the scope of the caller, or of another tenant, does not exist for them (404).
 */
@Controller('issues')
export class IssIssueAssigneesController {
  private readonly issues = new IssIssueStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get(':id/assignees')
  @OperationId('listIssueAssignees')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ items: Array<{ membership_id: string; display_name: string }>; next_cursor: null }> {
    const now = new Date();
    const people = await this.database.withTenant(tenant, (tx) => this.issues.assignees(tx, id, issueScope(access, PERMISSIONS.listIssueAssignees, now), now));
    if (people === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { items: people.map((person) => ({ membership_id: person.membershipId, display_name: person.displayName })), next_cursor: null };
  }
}
