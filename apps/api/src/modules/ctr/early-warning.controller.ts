import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { BidContractorStore, BidWorkflowReads, CtrEarlyWarningStore, TenantDatabase, contractScope } from '@machvon/db';
import type { ContractScopes, EarlyWarningActionMove, EarlyWarningFilter, EarlyWarningIssueMove, EarlyWarningMeetingMove, EarlyWarningMove } from '@machvon/db';
import { DomainError, EW_CATEGORIES, EW_PARTIES, EW_STATUSES } from '@machvon/kernel';
import type { EffectiveAccess, EwCategory, EwParty, EwStatus, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { registerDto, summaryDto, warningDto, warningLineDto } from './early-warning-view';
import { placeRefs, reaches } from './contract.controller';

const CLASSIFICATION = 'INTERNAL';
const WARNING_RESOURCE = 'contract_early_warning';
const REGISTER_RESOURCE = 'contract_early_warning_register';

const scopesFor = (access: EffectiveAccess, permission: string, now: Date): ContractScopes => ({ update: contractScope(access, permission, now), read: contractScope(access, PERMISSIONS.getContractEarlyWarning, now) });
const people = new BidWorkflowReads();

function flag(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value !== 'true' && value !== 'false') throw new DomainError('VALIDATION_FAILED', 422, field);
  return value === 'true';
}

function word<T extends string>(value: unknown, field: string, allowed: readonly string[]): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !allowed.includes(value)) throw new DomainError('VALIDATION_FAILED', 422, field);
  return value as T;
}

function uuidOf(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new DomainError('VALIDATION_FAILED', 422, field);
  return value.toLowerCase();
}

/**
 * The commands of the early-warning register of a contract (CTR-35, CTR-36, G1-15): any party raises a warning; it is assessed (a person who answers for it, a likelihood, the expected impact on time and cost) and
 * mitigated by actions with a person and a day; a meeting reviews every open warning; the register is issued with a snapshot and a hash; a warning is closed as resolved by somebody other than the person who
 * answers for it, as come true (naming the change order or the claim it became) or as withdrawn. The rhythm is a rule of the tenant (`EARLY_WARNING_POLICY`), not a constant.
 */
@Controller()
export class EarlyWarningController {
  private readonly register = new CtrEarlyWarningStore();

  @Post('contracts/:id/early-warnings')
  @HttpCode(200)
  @OperationId('raiseContractEarlyWarning')
  @Command({ operation: 'raiseContractEarlyWarning' })
  async raise(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['CtrEarlyWarningRaise']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.register.raise(
      scope.tx,
      id.toLowerCase(),
      { title: body.title, description: body.description, category: body.category, raisedByParty: body.raised_by_party, raisedOn: body.raised_on },
      scope.tenant.membershipId,
      scopesFor(access, PERMISSIONS.raiseContractEarlyWarning, now),
      now,
    );
    await this.writtenWarning(scope, done, 'ctr.early_warning.raised.v1', 'early_warning.raised', now);
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('contract-early-warnings/:id/assessment')
  @HttpCode(200)
  @OperationId('assessContractEarlyWarning')
  @Command({ operation: 'assessContractEarlyWarning', versioned: true })
  async assess(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['CtrEarlyWarningAssess']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.register.assess(
      scope.tx,
      id.toLowerCase(),
      scope.expectedVersion ?? 0,
      { ownerMembershipId: body.owner_membership_id, likelihood: body.likelihood, expectedTimeDays: body.expected_time_days, expectedCostVnd: body.expected_cost_vnd, noImpactExpected: body.no_impact_expected },
      scope.tenant.membershipId,
      scopesFor(access, PERMISSIONS.assessContractEarlyWarning, now),
      now,
    );
    await this.writtenWarning(scope, done, 'ctr.early_warning.updated.v1', 'early_warning.assessed', now);
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('contract-early-warnings/:id/actions')
  @HttpCode(200)
  @OperationId('addContractEarlyWarningAction')
  @Command({ operation: 'addContractEarlyWarningAction' })
  async addAction(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['CtrEarlyWarningActionCreate']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.register.addAction(
      scope.tx,
      id.toLowerCase(),
      { description: body.description, ownerMembershipId: body.owner_membership_id, dueOn: body.due_on },
      scope.tenant.membershipId,
      scopesFor(access, PERMISSIONS.addContractEarlyWarningAction, now),
      now,
    );
    await this.writtenAction(scope, done, 'early_warning.action_added', now);
    return commandResult(scope, done.actionStatus, done.actionVersion, done.actionId);
  }

  @Post('contract-early-warning-actions/:id/completion')
  @HttpCode(200)
  @OperationId('completeContractEarlyWarningAction')
  @Command({ operation: 'completeContractEarlyWarningAction', versioned: true })
  async completeAction(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['CtrEarlyWarningActionComplete']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.register.completeAction(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, body.outcome, body.note, scope.tenant.membershipId, scopesFor(access, PERMISSIONS.completeContractEarlyWarningAction, now), now);
    await this.writtenAction(scope, done, 'early_warning.action_ended', now);
    return commandResult(scope, done.actionStatus, done.actionVersion, done.actionId);
  }

  @Post('contract-early-warnings/:id/closure')
  @HttpCode(200)
  @OperationId('closeContractEarlyWarning')
  @Command({ operation: 'closeContractEarlyWarning', versioned: true })
  async close(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['CtrEarlyWarningClose']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.register.close(
      scope.tx,
      id.toLowerCase(),
      scope.expectedVersion ?? 0,
      { outcome: body.outcome, reason: body.reason, materialisedInto: body.materialised_into, materialisedId: body.materialised_id },
      scope.tenant.membershipId,
      scopesFor(access, PERMISSIONS.closeContractEarlyWarning, now),
      now,
    );
    await this.writtenWarning(scope, done, 'ctr.early_warning.closed.v1', 'early_warning.closed', now);
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('contracts/:id/early-warning-meetings')
  @HttpCode(200)
  @OperationId('recordContractEarlyWarningMeeting')
  @Command({ operation: 'recordContractEarlyWarningMeeting' })
  async meeting(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['CtrEarlyWarningMeetingRecord']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.register.recordMeeting(
      scope.tx,
      id.toLowerCase(),
      { heldOn: body.held_on, attendees: body.attendees, notes: body.notes, minutesDocumentVersionId: body.minutes_document_version_id, reviews: body.reviews },
      scope.tenant.membershipId,
      scopesFor(access, PERMISSIONS.recordContractEarlyWarningMeeting, now),
      now,
    );
    await this.writtenMeeting(scope, done, now);
    return commandResult(scope, 'RECORDED', 1, done.id);
  }

  @Post('contracts/:id/early-warning-issues')
  @HttpCode(200)
  @OperationId('issueContractEarlyWarningRegister')
  @Command({ operation: 'issueContractEarlyWarningRegister' })
  async issue(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['CtrEarlyWarningIssueRecord']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.register.issueRegister(scope.tx, id.toLowerCase(), { issuedOn: body.issued_on, meetingId: body.meeting_id }, scope.tenant.membershipId, scopesFor(access, PERMISSIONS.issueContractEarlyWarningRegister, now), now);
    await this.writtenIssue(scope, done, now);
    return commandResult(scope, done.kind, 1, done.id);
  }

  private async writtenWarning(scope: CommandScope, done: EarlyWarningMove, type: string, action: string, now: Date): Promise<void> {
    const facts = { contract_id: done.contractId, contract_code: done.contractCode, project_id: done.projectId, code: done.code, owner_membership_id: done.ownerMembershipId, materialised_into: done.materialisedInto, materialised_id: done.materialisedId };
    await scope.audit({ action: `ctr.${action}`, resourceType: WARNING_RESOURCE, resourceId: done.id, classification: CLASSIFICATION, diff: { from_status: done.fromStatus, to_status: done.status, ...facts } });
    await scope.emit({
      aggregateType: WARNING_RESOURCE,
      aggregateId: done.id,
      aggregateVersion: done.version,
      type,
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, warning_id: done.id, status: done.status, from_status: done.fromStatus, ...facts, version: done.version, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${WARNING_RESOURCE}:${done.id}:${done.version}:${type}`,
    });
  }

  private async writtenAction(scope: CommandScope, done: EarlyWarningActionMove, action: string, now: Date): Promise<void> {
    const facts = { contract_id: done.contractId, contract_code: done.contractCode, project_id: done.projectId, warning_code: done.code, action_id: done.actionId, action_status: done.actionStatus, due_on: done.dueOn };
    await scope.audit({ action: `ctr.${action}`, resourceType: WARNING_RESOURCE, resourceId: done.id, classification: CLASSIFICATION, diff: { from_status: done.fromStatus, to_status: done.status, ...facts } });
    await scope.emit({
      aggregateType: WARNING_RESOURCE,
      aggregateId: done.id,
      aggregateVersion: done.version,
      type: 'ctr.early_warning.updated.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, warning_id: done.id, status: done.status, ...facts, version: done.version, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${WARNING_RESOURCE}:${done.id}:action:${done.actionId}:${done.actionVersion}`,
    });
  }

  private async writtenMeeting(scope: CommandScope, done: EarlyWarningMeetingMove, now: Date): Promise<void> {
    const facts = { contract_id: done.contractId, contract_code: done.contractCode, project_id: done.projectId, ordinal: done.ordinal, held_on: done.heldOn, reviewed: done.reviewed };
    await scope.audit({ action: 'ctr.early_warning_register.meeting_recorded', resourceType: REGISTER_RESOURCE, resourceId: done.id, classification: CLASSIFICATION, diff: facts });
    await scope.emit({
      aggregateType: REGISTER_RESOURCE,
      aggregateId: done.id,
      aggregateVersion: 1,
      type: 'ctr.early_warning_register.meeting_recorded.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, meeting_id: done.id, ...facts, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${REGISTER_RESOURCE}:meeting:${done.id}`,
    });
  }

  private async writtenIssue(scope: CommandScope, done: EarlyWarningIssueMove, now: Date): Promise<void> {
    const facts = { contract_id: done.contractId, contract_code: done.contractCode, project_id: done.projectId, ordinal: done.ordinal, kind: done.kind, issued_on: done.issuedOn, meeting_id: done.meetingId, warning_count: done.warningCount, open_count: done.openCount, content_hash: done.contentHash };
    await scope.audit({ action: 'ctr.early_warning_register.issued', resourceType: REGISTER_RESOURCE, resourceId: done.id, classification: CLASSIFICATION, diff: facts });
    await scope.emit({
      aggregateType: REGISTER_RESOURCE,
      aggregateId: done.id,
      aggregateVersion: 1,
      type: 'ctr.early_warning_register.issued.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, issue_id: done.id, ...facts, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${REGISTER_RESOURCE}:issue:${done.id}`,
    });
  }
}

/**
 * The reads of the early-warning register: the warnings of a filter with their summary, the record of a warning, and the register of one contract (its three clocks, its meetings and its issues). For the staff who
 * hold `early_warning.read` over the contract; never for a contractor of the contract (403 `SCOPE_DENIED`), 404 for what is outside the scope of the caller.
 */
@Controller()
export class EarlyWarningReadsController {
  private readonly register = new CtrEarlyWarningStore();
  private readonly contractors = new BidContractorStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('contract-early-warnings')
  @OperationId('listContractEarlyWarnings')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('contract_id') contractId?: unknown,
    @Query('status') status?: unknown,
    @Query('open') open?: unknown,
    @Query('category') category?: unknown,
    @Query('raised_by_party') party?: unknown,
    @Query('mine') mine?: unknown,
    @Query('cursor') cursor?: unknown,
    @Query('limit') limit?: unknown,
  ): Promise<Record<string, unknown>> {
    const request = parsePageRequest(limit, cursor);
    const filter: EarlyWarningFilter = {
      contractId: uuidOf(contractId, 'contract_id'),
      status: word<EwStatus>(status, 'status', EW_STATUSES),
      open: flag(open, 'open'),
      category: word<EwCategory>(category, 'category', EW_CATEGORIES),
      raisedByParty: word<EwParty>(party, 'raised_by_party', EW_PARTIES),
      ownerMembershipId: flag(mine, 'mine') === true ? tenant.membershipId : undefined,
    };
    const now = new Date();
    const read = contractScope(access, PERMISSIONS.listContractEarlyWarnings, now);
    return this.database.withTenant(tenant, async (tx) => {
      if ((await this.contractors.callerOf(tx, tenant.membershipId)).guest) throw new DomainError('SCOPE_DENIED', 403);
      const page = await this.register.list(tx, filter, read, { limit: request.limit, after: request.after?.id }, now);
      const names = await people.names(tx, page.rows.map((row) => row.ownerMembershipId));
      return {
        items: page.rows.map((row) => warningLineDto(row, names)),
        next_cursor: page.nextCursor === null ? null : encodeCursor({ code: 'warning', id: page.nextCursor }),
        summary: summaryDto(page.summary),
        truncated: page.truncated,
        as_of: page.asOf,
      };
    });
  }

  @Get('contract-early-warnings/:id')
  @OperationId('getContractEarlyWarning')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = new Date();
    const read = contractScope(access, PERMISSIONS.getContractEarlyWarning, now);
    return this.database.withTenant(tenant, async (tx) => {
      if ((await this.contractors.callerOf(tx, tenant.membershipId)).guest) throw new DomainError('SCOPE_DENIED', 403);
      const detail = await this.register.get(tx, id.toLowerCase(), read, now);
      const names = await people.names(tx, [detail.row.raisedBy, detail.row.ownerMembershipId, detail.row.assessedBy, detail.row.closedBy, ...detail.actions.flatMap((action) => [action.ownerMembershipId, action.doneBy])]);
      const refs = placeRefs(detail.row.reach);
      return warningDto(detail, names, { manage: reaches(access, PERMISSIONS.assessContractEarlyWarning, refs, now), close: reaches(access, PERMISSIONS.closeContractEarlyWarning, refs, now) }, now.toISOString());
    });
  }

  @Get('contracts/:id/early-warning-register')
  @OperationId('getContractEarlyWarningRegister')
  async registerOf(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = new Date();
    const read = contractScope(access, PERMISSIONS.getContractEarlyWarningRegister, now);
    return this.database.withTenant(tenant, async (tx) => {
      if ((await this.contractors.callerOf(tx, tenant.membershipId)).guest) throw new DomainError('SCOPE_DENIED', 403);
      const view = await this.register.register(tx, id.toLowerCase(), read, now);
      const names = await people.names(tx, [...view.meetings.map((meeting) => meeting.recordedBy), ...view.issues.map((issue) => issue.issuedBy)]);
      const place = await tx.query<{ project_id: string; owner_unit_id: string; owner_unit_path: string; investor_unit_id: string | null; investor_unit_path: string | null }>(
        `select p.id as project_id, ou.id as owner_unit_id, ou.path as owner_unit_path, iu.id as investor_unit_id, iu.path as investor_unit_path
           from machvon.contract c join machvon.project p on p.tenant_id = c.tenant_id and p.id = c.project_id
           join machvon.organization_unit ou on ou.tenant_id = p.tenant_id and ou.id = p.owner_unit_id
           left join machvon.organization_unit iu on iu.tenant_id = p.tenant_id and iu.id = p.investor_unit_id where c.id = $1::uuid`,
        [view.contract.id],
      );
      const row = place[0];
      const refs = row === undefined ? [] : placeRefs({ contractId: view.contract.id, projectId: row.project_id, ownerUnit: { id: row.owner_unit_id, path: row.owner_unit_path }, investorUnit: row.investor_unit_id === null || row.investor_unit_path === null ? null : { id: row.investor_unit_id, path: row.investor_unit_path } });
      return registerDto(view, names, { raise: reaches(access, PERMISSIONS.raiseContractEarlyWarning, refs, now), manage: reaches(access, PERMISSIONS.recordContractEarlyWarningMeeting, refs, now) });
    });
  }
}
