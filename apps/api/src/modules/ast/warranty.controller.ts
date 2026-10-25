import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { AstWarrantyStore, TenantDatabase, handoverScope } from '@machvon/db';
import type { AstWarrantyResult, HandoverScopes } from '@machvon/db';
import { DomainError, asUuid, vietnamDateOf } from '@machvon/kernel';
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
import { warrantyView } from './warranty-view';
import type { WarrantyPermissions } from './warranty-view';

const MANAGE_PERMISSION = PERMISSIONS.createWarrantyObligation;
const READ_PERMISSION = PERMISSIONS.listWarrantyObligations;
const RESOURCE_TYPE = 'warranty_obligation';
const CLASSIFICATION = 'INTERNAL';

const ACTION_PERMISSIONS: WarrantyPermissions = { manage: MANAGE_PERMISSION };

const scopesFor = (access: EffectiveAccess, now: Date): HandoverScopes => ({ update: handoverScope(access, MANAGE_PERMISSION, now), read: handoverScope(access, READ_PERMISSION, now) });

/**
 * The warranty a work carries after its handover (ST-AST-003, AST 3.3, BR-AST-03, BR-AST-05). The project office creates the obligation for an accepted handover with a term that is not below the
 * minimum the rule data states for the grade of the work (422 `WARRANTY_PERIOD_BELOW_MINIMUM`), covered by a warranty guarantee or an amount held back (422 `GUARANTEE_REQUIRED`); it closes it once
 * it has run out and no claim is open (422 `WARRANTY_NOT_EXPIRED`, 422 `OPEN_WARRANTY_CLAIMS`). The closure is announced (`ast.warranty.closed.v1`) so that the retention and the warranty
 * guarantee of the contract can be released, and not before.
 */
@Controller()
export class WarrantyController {
  private readonly warranties = new AstWarrantyStore();

  @Post('warranty-obligations')
  @HttpCode(200)
  @OperationId('createWarrantyObligation')
  @Command({ operation: 'createWarrantyObligation' })
  async create(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['AstCreateWarrantyObligation']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.warranties.create(
      scope.tx,
      {
        contractId: body.contract_id,
        handoverId: body.handover_id,
        assetId: body.asset_id,
        scopeDescription: body.scope_description,
        startsOn: body.starts_on,
        periodMonths: body.period_months,
        warrantyGuaranteeId: body.warranty_guarantee_id,
        retentionAmountVnd: body.retention_amount_vnd,
        constructionGrade: body.construction_grade,
      },
      scope.tenant.membershipId,
      scopesFor(access, now),
      now,
    );
    await this.written(scope, done, 'warranty.created', 'ast.warranty.created.v1', now);
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('warranty-obligations/:id/close')
  @HttpCode(200)
  @OperationId('closeWarrantyObligation')
  @Command({ operation: 'closeWarrantyObligation' })
  async close(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['AstCloseWarrantyObligation'],
  ): Promise<CommandResult> {
    const now = new Date();
    const done = await this.warranties.close(scope.tx, id.toLowerCase(), { note: body.note }, scope.tenant.membershipId, scopesFor(access, now), now);
    await this.written(scope, done, 'warranty.closed', 'ast.warranty.closed.v1', now);
    return commandResult(scope, done.status, done.version, done.id);
  }

  /** The audit row and the event of a command: ids, the dates and the terms of the warranty, and what it holds back or is covered by. */
  private async written(scope: CommandScope, done: AstWarrantyResult, action: string, type: string, now: Date): Promise<void> {
    const facts = {
      contract_id: done.contractId,
      contract_code: done.contractCode,
      handover_id: done.handoverId,
      project_id: done.projectId,
      asset_id: done.assetId,
      starts_on: done.startsOn,
      ends_on: done.endsOn,
      period_months: done.periodMonths,
      construction_grade: done.constructionGrade,
      minimum_months: done.minimumMonths,
      rule_version_id: done.ruleVersionId,
      warranty_guarantee_id: done.warrantyGuaranteeId,
      retention_amount_vnd: done.retentionAmountVnd,
    };
    await scope.audit({ action, resourceType: RESOURCE_TYPE, resourceId: done.id, classification: CLASSIFICATION, diff: { from_status: done.fromStatus, to_status: done.status, ...facts } });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: done.id,
      aggregateVersion: done.version,
      type,
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        obligation_id: done.id,
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

const idFilter = (value: unknown, field: string): string | undefined => {
  if (value === undefined) return undefined;
  const id = typeof value === 'string' ? asUuid(value) : undefined;
  if (id === undefined) throw new DomainError('VALIDATION_FAILED', 422, field);
  return id.toLowerCase();
};

/** The obligations in the scope of the caller (the right to read them is `warranty.read`). */
@Controller('warranty-obligations')
export class WarrantyReadsController {
  private readonly warranties = new AstWarrantyStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  @OperationId('listWarrantyObligations')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
    @Query('contract_id') contractId?: unknown,
    @Query('handover_id') handoverId?: unknown,
    @Query('status') status?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const request = parsePageRequest(limit, cursor);
    if (status !== undefined && typeof status !== 'string') throw new DomainError('VALIDATION_FAILED', 422, 'status');
    const now = new Date();
    const filter = {
      contractId: idFilter(contractId, 'contract_id'),
      handoverId: idFilter(handoverId, 'handover_id'),
      status,
      today: vietnamDateOf(now),
      limit: request.limit + 1,
      after: request.after,
    };
    const rows = await this.database.withTenant(tenant, (tx) => this.warranties.list(tx, handoverScope(access, READ_PERMISSION, now), filter));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map((line) => warrantyView(line, access, now, ACTION_PERMISSIONS)),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.createdAt, id: last.id }) : null,
      as_of: now.toISOString(),
    };
  }
}
