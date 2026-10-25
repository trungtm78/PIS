import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { BidContractorStore, QmsNonconformanceStore, TenantDatabase, contractScope } from '@machvon/db';
import type { ContractScopes, QmsActionResult, QmsNonconformanceResult } from '@machvon/db';
import { DomainError, asUuid } from '@machvon/kernel';
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
import { nonconformanceAllowed, nonconformanceView } from './nonconformance-view';
import type { NonconformancePermissions } from './nonconformance-view';

const RAISE_PERMISSION = PERMISSIONS.raiseNonconformance;
const MANAGE_PERMISSION = PERMISSIONS.assignCorrectiveAction;
const RESPOND_PERMISSION = PERMISSIONS.submitCorrectiveEvidence;
const VERIFY_PERMISSION = PERMISSIONS.verifyCorrectiveAction;
const CLOSE_PERMISSION = PERMISSIONS.closeNonconformance;
const READ_PERMISSION = PERMISSIONS.get_resources_quality_nonconformance;
const RESOURCE_TYPE = 'nonconformance';
const CLASSIFICATION = 'INTERNAL';

const ACTION_PERMISSIONS: NonconformancePermissions = { manage: MANAGE_PERMISSION, respond: RESPOND_PERMISSION, verify: VERIFY_PERMISSION, close: CLOSE_PERMISSION };

const scopesFor = (access: EffectiveAccess, permission: string, now: Date): ContractScopes => ({ update: contractScope(access, permission, now), read: contractScope(access, READ_PERMISSION, now) });

/**
 * The non-conformances of the work under a contract and the actions that put them right (ST-QMS-006, QMS 3.3, BR-QMS-07). A supervisor raises one against a contract that is being performed, with its
 * seriousness and where it came from; a critical one holds back the quality acceptance until it is closed. Actions are assigned to people with a day; whoever carries one out answers it with evidence,
 * someone other than the people responsible verifies it or gives it back (403 `SELF_APPROVAL_DENIED`), and a non-conformance whose actions are all verified is closed by someone who is none of them
 * (422 `CORRECTIVE_ACTION_OPEN` before that). A closed one can be reopened.
 */
@Controller()
export class NonconformanceController {
  private readonly nonconformances = new QmsNonconformanceStore();

  @Post('nonconformances')
  @HttpCode(200)
  @OperationId('raiseNonconformance')
  @Command({ operation: 'raiseNonconformance' })
  async raise(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['QmsRaiseNonconformance']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.nonconformances.raise(
      scope.tx,
      {
        contractId: body.contract_id,
        measurementId: body.measurement_id,
        severity: body.severity,
        title: body.title,
        description: body.description,
        sourceKind: body.source_kind,
        inspectionId: body.inspection_id,
        materialTestId: body.material_test_id,
        siteDiaryId: body.site_diary_id,
        actionOwnerId: body.action_owner_id,
        dueAt: body.due_at,
      },
      scope.tenant.membershipId,
      scopesFor(access, RAISE_PERMISSION, now),
      now,
    );
    await this.written(scope, done, 'nonconformance.raised', 'qms.ncr.raised.v1', now);
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('nonconformances/:id/corrective-actions')
  @HttpCode(200)
  @OperationId('assignCorrectiveAction')
  @Command({ operation: 'assignCorrectiveAction', versioned: true })
  async assign(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['QmsAssignCorrectiveAction'],
  ): Promise<CommandResult> {
    const now = new Date();
    const done = await this.nonconformances.assign(
      scope.tx,
      id.toLowerCase(),
      scope.expectedVersion ?? 0,
      { description: body.description, ownerMembershipId: body.owner_membership_id, dueAt: body.due_at },
      scope.tenant.membershipId,
      scopesFor(access, MANAGE_PERMISSION, now),
      now,
    );
    await this.written(scope, done, 'corrective_action.assigned', 'qms.corrective_action.assigned.v1', now);
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('corrective-actions/:id/evidence')
  @HttpCode(200)
  @OperationId('submitCorrectiveEvidence')
  @Command({ operation: 'submitCorrectiveEvidence' })
  async submit(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['QmsSubmitCorrectiveEvidence'],
  ): Promise<CommandResult> {
    const now = new Date();
    const done = await this.nonconformances.submitEvidence(
      scope.tx,
      id.toLowerCase(),
      { evidenceDocumentVersionId: body.evidence_document_version_id, evidencePhotoId: body.evidence_photo_id, note: body.note },
      scope.tenant.membershipId,
      scopesFor(access, RESPOND_PERMISSION, now),
      now,
    );
    await this.written(scope, done, 'corrective_action.submitted', 'qms.corrective_action.submitted.v1', now);
    return this.actionResult(scope, done);
  }

  @Post('corrective-actions/:id/verify')
  @HttpCode(200)
  @OperationId('verifyCorrectiveAction')
  @Command({ operation: 'verifyCorrectiveAction' })
  async verify(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['QmsVerifyCorrectiveAction'],
  ): Promise<CommandResult> {
    const now = new Date();
    const done = await this.nonconformances.verify(
      scope.tx,
      id.toLowerCase(),
      { outcome: body.outcome, verificationNote: body.verification_note },
      scope.tenant.membershipId,
      scopesFor(access, VERIFY_PERMISSION, now),
      now,
    );
    await this.written(scope, done, 'corrective_action.verified', 'qms.corrective_action.verified.v1', now, body.verification_note);
    return this.actionResult(scope, done);
  }

  @Post('nonconformances/:id/close')
  @HttpCode(200)
  @OperationId('closeNonconformance')
  @Command({ operation: 'closeNonconformance', versioned: true })
  async close(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['QmsCloseNonconformance']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.nonconformances.close(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, body.closure_note, scope.tenant.membershipId, scopesFor(access, CLOSE_PERMISSION, now), now);
    await this.written(scope, done, 'nonconformance.closed', 'qms.ncr.closed.v1', now, body.closure_note);
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('nonconformances/:id/reopen')
  @HttpCode(200)
  @OperationId('reopenNonconformance')
  @Command({ operation: 'reopenNonconformance', versioned: true })
  async reopen(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['QmsReopenNonconformance'],
  ): Promise<CommandResult> {
    const now = new Date();
    const done = await this.nonconformances.reopen(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, body.reason, scope.tenant.membershipId, scopesFor(access, CLOSE_PERMISSION, now), now);
    await this.written(scope, done, 'nonconformance.reopened', 'qms.ncr.reopened.v1', now, body.reason);
    return commandResult(scope, done.status, done.version, done.id);
  }

  /** What an answer or a verification answers: the action it was about, with the status and version the action now has. */
  private actionResult(scope: CommandScope, done: QmsActionResult): CommandResult {
    return commandResult(scope, done.action.status, done.action.version, done.action.id);
  }

  /**
   * The audit row and the event of a command: ids, codes, statuses and counts, never the words of a note beyond the audit row that keeps the reason. A critical one that was raised is what ISS
   * and CTR watch for (`blocks_acceptance`).
   */
  private async written(scope: CommandScope, done: QmsNonconformanceResult, action: string, type: string, now: Date, reason?: string): Promise<void> {
    const facts = {
      ncr_no: done.ncrNo,
      contract_id: done.contractId,
      contract_code: done.contractCode,
      project_id: done.projectId,
      severity: done.severity,
      source_kind: done.sourceKind,
      blocks_acceptance: done.blocksAcceptance,
      open_actions: done.openActions,
      corrective_action_id: done.action?.id ?? null,
      corrective_action_status: done.action?.status ?? null,
    };
    await scope.audit({
      action,
      resourceType: RESOURCE_TYPE,
      resourceId: done.id,
      classification: CLASSIFICATION,
      ...(reason === undefined ? {} : { reason }),
      diff: { from_status: done.fromStatus, to_status: done.status, ...facts },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: done.id,
      aggregateVersion: done.version,
      type,
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        nonconformance_id: done.id,
        ...facts,
        status: done.status,
        from_status: done.fromStatus,
        version: done.version,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
      },
      eventKey: `${RESOURCE_TYPE}:${done.id}:${done.version}`,
    });
  }
}

/** The non-conformances of the contracts in the scope of the caller (the right to read them is `quality_nonconformance.read`; a guest contractor holds it over its own contract). */
@Controller('resources/quality_nonconformance')
export class NonconformanceReadsController {
  private readonly nonconformances = new QmsNonconformanceStore();
  private readonly contractors = new BidContractorStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  @OperationId('get_resources_quality_nonconformance')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
    @Query('contract_id') contractId?: unknown,
    @Query('status') status?: unknown,
    @Query('severity') severity?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const request = parsePageRequest(limit, cursor);
    const filter = {
      contractId: this.idFilter(contractId, 'contract_id'),
      status: this.textFilter(status, 'status'),
      severity: this.textFilter(severity, 'severity'),
      limit: request.limit + 1,
      after: request.after,
    };
    const now = new Date();
    const { rows, guest } = await this.database.withTenant(tenant, async (tx) => ({
      rows: await this.nonconformances.list(tx, contractScope(access, READ_PERMISSION, now), filter),
      guest: (await this.contractors.callerOf(tx, tenant.membershipId)).guest,
    }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map((line) => nonconformanceView(line, nonconformanceAllowed(line, access, tenant.membershipId, now, ACTION_PERMISSIONS), { rootCause: !guest })),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.createdAt, id: last.id }) : null,
      as_of: now.toISOString(),
    };
  }

  @Get(':id')
  @OperationId('get_resources_quality_nonconformance_id')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = new Date();
    const { line, guest } = await this.database.withTenant(tenant, async (tx) => ({
      line: await this.nonconformances.find(tx, id.toLowerCase(), contractScope(access, READ_PERMISSION, now)),
      guest: (await this.contractors.callerOf(tx, tenant.membershipId)).guest,
    }));
    // A non-conformance in another tenant or outside the scope of the caller is indistinguishable from one that does not exist.
    if (line === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return nonconformanceView(line, nonconformanceAllowed(line, access, tenant.membershipId, now, ACTION_PERMISSIONS), { rootCause: !guest });
  }

  private idFilter(value: unknown, field: string): string | undefined {
    if (value === undefined) return undefined;
    const id = typeof value === 'string' ? asUuid(value) : undefined;
    if (id === undefined) throw new DomainError('VALIDATION_FAILED', 422, field);
    return id.toLowerCase();
  }

  private textFilter(value: unknown, field: string): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string') throw new DomainError('VALIDATION_FAILED', 422, field);
    return value;
  }
}
