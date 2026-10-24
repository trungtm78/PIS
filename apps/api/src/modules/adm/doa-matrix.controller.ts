import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { DoaMatrixStore, TenantDatabase } from '@machvon/db';
import type { DoaMatrixRow } from '@machvon/db';
import { DomainError } from '@machvon/kernel';
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
import { holdsOnWholeTenant } from './tenant-authority';

const MANAGE_PERMISSION = PERMISSIONS.createDoaMatrixDraft;
const READ_PERMISSION = PERMISSIONS.get_resources_doa_matrix_version;
const APPROVE_PERMISSION = PERMISSIONS.decideDoaMatrix;
const RESOURCE_TYPE = 'doa_matrix_version';

/** The matrix decides who approves what for the whole tenant (ADM 3.6): it is not owned by one organisation unit, so only a grant on the whole tenant reaches it. */
function assertHolds(access: EffectiveAccess, permission: string): void {
  if (!holdsOnWholeTenant(access, permission)) throw new DomainError('SCOPE_DENIED', 403);
}

/**
 * Delegation-of-authority matrix commands (ST-ADM-011, ADM 3.6). A draft changes nothing; once a second person approves it,
 * the version becomes the matrix in force from its first day and the one it replaces ends there. Running approvals keep the
 * version they were pinned to; only the ones that start afterwards read the new one (`DoaMatrixStore.resolve`).
 */
@Controller('doa-matrices')
export class DoaMatricesController {
  private readonly store = new DoaMatrixStore();

  @Post()
  @OperationId('createDoaMatrixDraft')
  @Command({ operation: 'createDoaMatrixDraft' })
  async create(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['DoaMatrixDraft']): Promise<CommandResult> {
    assertHolds(access, MANAGE_PERMISSION);
    const created = await this.store.createDraft(scope.tx, body, scope.tenant.membershipId);
    await scope.audit({
      action: 'doa.drafted',
      resourceType: RESOURCE_TYPE,
      resourceId: created.id,
      classification: 'INTERNAL',
      diff: { revision: created.revision, effective_from: body.effective_from, rules: body.rules.length },
    });
    return commandResult(scope, 'DRAFTED', created.version, created.id);
  }

  @Put(':matrixId')
  @OperationId('updateDoaMatrixDraft')
  @Command({ operation: 'updateDoaMatrixDraft', versioned: true })
  async update(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('matrixId', ParseUUIDPipe) matrixId: string,
    @Body() body: Schemas['DoaMatrixDraft'],
  ): Promise<CommandResult> {
    assertHolds(access, MANAGE_PERMISSION);
    const { version } = await this.store.updateDraft(scope.tx, matrixId, scope.expectedVersion ?? 0, body, scope.tenant.membershipId);
    await scope.audit({
      action: 'doa.updated',
      resourceType: RESOURCE_TYPE,
      resourceId: matrixId,
      classification: 'INTERNAL',
      diff: { effective_from: body.effective_from, rules: body.rules.length },
    });
    return commandResult(scope, 'UPDATED', version, matrixId);
  }

  @Post(':matrixId/submit')
  @HttpCode(200)
  @OperationId('submitDoaMatrix')
  @Command({ operation: 'submitDoaMatrix', versioned: true })
  async submit(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('matrixId', ParseUUIDPipe) matrixId: string,
    @Body() body: Schemas['ReasonOnly'],
  ): Promise<CommandResult> {
    assertHolds(access, MANAGE_PERMISSION);
    const { version } = await this.store.submit(scope.tx, matrixId, scope.expectedVersion ?? 0, scope.tenant.membershipId);
    await scope.audit({ action: 'doa.submitted', resourceType: RESOURCE_TYPE, resourceId: matrixId, reason: body.reason, classification: 'INTERNAL', diff: { version } });
    return commandResult(scope, 'SUBMITTED', version, matrixId);
  }

  @Post(':matrixId/decision')
  @HttpCode(200)
  @OperationId('decideDoaMatrix')
  @Command({ operation: 'decideDoaMatrix', versioned: true })
  async decide(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('matrixId', ParseUUIDPipe) matrixId: string,
    @Body() body: Schemas['Decision'],
  ): Promise<CommandResult> {
    assertHolds(access, APPROVE_PERMISSION);
    const decided = await this.store.decide(scope.tx, matrixId, scope.expectedVersion ?? 0, body.decision, scope.tenant.membershipId);
    await scope.audit({
      action: 'doa.decided',
      resourceType: RESOURCE_TYPE,
      resourceId: matrixId,
      reason: body.reason,
      classification: 'INTERNAL',
      diff: { decision: body.decision, revision: decided.revision, evidence: body.evidence_ids.length, superseded_id: decided.supersededId ?? null },
    });
    if (decided.status === 'PUBLISHED') {
      await scope.emit({
        aggregateType: RESOURCE_TYPE,
        aggregateId: matrixId,
        aggregateVersion: decided.version,
        type: 'adm.doa_matrix.published.v1',
        schemaVersion: 1,
        payload: { matrix_id: matrixId, revision: decided.revision, effective_from: decided.effectiveFrom },
        eventKey: `${RESOURCE_TYPE}:${matrixId}:${decided.version}`,
      });
    }
    return commandResult(scope, decided.status, decided.version, matrixId);
  }
}

/** openapi.json get_resources_doa_matrix_version item: the version with its rules in the order they were written. */
function viewOf(row: DoaMatrixRow): Record<string, unknown> {
  return {
    id: row.id,
    revision: row.revision,
    status: row.status,
    effective_from: row.effectiveFrom,
    effective_until: row.effectiveUntil,
    legal_basis_ref: row.legalBasis,
    created_by: row.createdBy,
    last_edited_by: row.lastEditedBy,
    approved_by: row.approvedBy,
    published_at: row.publishedAt,
    version: row.version,
    rules: row.rules.map((rule) => ({ ...rule })),
  };
}

/** Reads of the matrix versions (get_resources_doa_matrix_version and its id form): newest revision first, tenant-wide. */
@Controller('resources/doa_matrix_version')
export class DoaMatrixReadsController {
  private readonly store = new DoaMatrixStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  @OperationId('get_resources_doa_matrix_version')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null }> {
    const request = parsePageRequest(limit, cursor);
    if (!holdsOnWholeTenant(access, READ_PERMISSION)) return { items: [], next_cursor: null };
    const rows = await this.database.withTenant(tenant, (tx) => this.store.list(tx, { limit: request.limit + 1, after: request.after }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map(viewOf),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: String(last.revision), id: last.id }) : null,
    };
  }

  @Get(':id')
  @OperationId('get_resources_doa_matrix_version_id')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    if (!holdsOnWholeTenant(access, READ_PERMISSION)) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const row = await this.database.withTenant(tenant, (tx) => this.store.find(tx, id));
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return viewOf(row);
  }
}
