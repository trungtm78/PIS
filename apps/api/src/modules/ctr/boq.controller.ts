import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { BidContractorStore, CtrBoqStore, TenantDatabase, contractScope } from '@machvon/db';
import type { ContractScopes } from '@machvon/db';
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
import { BoqFileGuard, BoqFileKey } from './boq-file.guard';
import { boqLineView } from './boq-view';
import { placeRefs, reaches } from './contract.controller';

const MANAGE_PERMISSION = PERMISSIONS.importBoqLines;
const READ_PERMISSION = PERMISSIONS.get_resources_boq_line;
const RECORD_PERMISSION = PERMISSIONS.recordMeasurement;
const RESOURCE_TYPE = 'contract_revision';
const CLASSIFICATION = 'INTERNAL';

const scopesOf = (access: EffectiveAccess, now: Date): ContractScopes => ({ update: contractScope(access, MANAGE_PERMISSION, now), read: contractScope(access, READ_PERMISSION, now) });

/** A filter of the list that names an id: a value that is not a uuid is a fault of the request, never a miss. */
function idFilter(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  const id = asUuid(value);
  if (id === undefined) throw new DomainError('VALIDATION_FAILED', 422, field);
  return id;
}

/**
 * The BOQ of a contract revision (ST-CTR-002, CTR 3.1 step 2): the lines arrive as JSON or as a file (CSV or XLSX, scanned before it is
 * read), REPLACE the lines of a draft revision or APPEND to them, and the same file is imported once. The revision, the contract and the
 * ledger totals have no other write path here. A command acts on a revision inside the scope of `boq.manage`: one the caller cannot see
 * does not exist for them.
 */
@Controller()
export class BoqController {
  private readonly boq = new CtrBoqStore();

  @Post('contract-revisions/:id/boq-lines')
  @HttpCode(200)
  @UseGuards(BoqFileGuard)
  @OperationId('importBoqLines')
  @Command({ operation: 'importBoqLines', versioned: true })
  async importLines(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['CtrImportBoqLines'],
    @BoqFileKey() fileObjectKey: string | undefined,
  ): Promise<CommandResult & Record<string, unknown>> {
    const now = new Date();
    const actor = scope.tenant.membershipId;
    const done = await this.boq.importLines(scope.tx, id, scope.expectedVersion ?? 0, { mode: body.mode, lines: body.lines, fileSha256: body.file_sha256, fileObjectKey }, actor, scopesOf(access, now));
    const figures = {
      import_id: done.importId,
      mode: done.mode,
      source_kind: done.sourceKind,
      file_sha256: done.sourceSha256,
      lines_imported: done.linesImported,
      items_created: done.itemsCreated,
      lines_total_vnd: done.reconciliation.linesTotalVnd,
    };
    // A file that was imported already changes nothing: the answer is the first one, and the trail records only that it was asked again.
    await scope.audit({
      action: done.duplicate ? 'boq.import_repeated' : 'boq.imported',
      resourceType: RESOURCE_TYPE,
      resourceId: done.revisionId,
      classification: CLASSIFICATION,
      diff: done.duplicate ? { import_id: done.importId, file_sha256: done.sourceSha256 } : { ...figures, ...(fileObjectKey === undefined ? {} : { file_object_key: fileObjectKey }) },
    });
    if (!done.duplicate) {
      await scope.emit({
        aggregateType: RESOURCE_TYPE,
        aggregateId: done.revisionId,
        aggregateVersion: done.version,
        type: 'ctr.boq.imported.v1',
        schemaVersion: 1,
        payload: {
          tenant_id: scope.tenant.tenantId,
          contract_id: done.contractId,
          revision_id: done.revisionId,
          version: done.version,
          actor_id: actor,
          occurred_at: now.toISOString(),
          ...figures,
          revision_amount_vnd: done.reconciliation.revisionAmountVnd,
        },
        eventKey: `${RESOURCE_TYPE}:${done.revisionId}:${done.version}`,
      });
    }
    return {
      ...commandResult(scope, 'DRAFT', done.version, done.revisionId),
      import_id: done.importId,
      duplicate: done.duplicate,
      lines_imported: done.linesImported,
      items_created: done.itemsCreated,
      retention_defaulted: done.retentionDefaulted,
      lines_total_vnd: done.reconciliation.linesTotalVnd,
      revision_amount_vnd: done.reconciliation.revisionAmountVnd,
      difference_vnd: done.reconciliation.differenceVnd,
      balanced: done.reconciliation.matches,
    };
  }
}

/**
 * The lines of the BOQs (CTR-04): a DTO allowlist filtered by the unit tree, the project and the contract grants. A line outside the scope of
 * the caller is indistinguishable from one that does not exist; a guest contractor reads the lines of its own contract. The list can be
 * narrowed to one contract (`contract_id`) or one revision (`contract_revision_id`).
 */
@Controller('resources/boq_line')
export class BoqLineReadsController {
  private readonly boq = new CtrBoqStore();
  private readonly contractors = new BidContractorStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  @OperationId('get_resources_boq_line')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
    @Query('contract_id') contractId?: unknown,
    @Query('contract_revision_id') revisionId?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const request = parsePageRequest(limit, cursor);
    const filter = { contractId: idFilter(contractId, 'contract_id'), revisionId: idFilter(revisionId, 'contract_revision_id') };
    const now = new Date();
    const { rows, guest } = await this.database.withTenant(tenant, async (tx) => ({
      rows: await this.boq.list(tx, contractScope(access, READ_PERMISSION, now), { limit: request.limit + 1, after: request.after }, filter),
      guest: (await this.contractors.callerOf(tx, tenant.membershipId)).guest,
    }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map((row) => boqLineView(row, { item: !guest || reaches(access, RECORD_PERMISSION, placeRefs(row.reach), now) })),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.key, id: last.id }) : null,
      as_of: now.toISOString(),
    };
  }

  @Get(':id')
  @OperationId('get_resources_boq_line_id')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = new Date();
    const view = await this.database.withTenant(tenant, async (tx) => {
      const row = await this.boq.find(tx, id, contractScope(access, READ_PERMISSION, now));
      if (row === undefined) return undefined;
      const guest = (await this.contractors.callerOf(tx, tenant.membershipId)).guest;
      return boqLineView(row, { item: !guest || reaches(access, RECORD_PERMISSION, placeRefs(row.reach), now) });
    });
    // A line in another tenant or outside the scope of the caller is indistinguishable from one that does not exist.
    if (view === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return view;
  }
}
