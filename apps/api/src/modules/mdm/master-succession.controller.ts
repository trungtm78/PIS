import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { MasterSuccessionStore, TenantDatabase } from '@machvon/db';
import type { MasterVersionRow, StructureReading, SuccessionEdgeRow, SuccessionTarget } from '@machvon/db';
import { DomainError, asUuid, vietnamDateOf } from '@machvon/kernel';
import type { TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { dateOf } from './inputs';

const CHANGE_RESOURCE_TYPE = 'master_change_request';

function versionViewOf(row: MasterVersionRow): Record<string, unknown> {
  return {
    id: row.id,
    revision: row.revision,
    label: row.label,
    parent_record_id: row.parentRecordId,
    attributes: row.attributes,
    valid_from: row.validFrom,
    valid_until: row.validUntil,
    status: row.status,
    legal_basis: row.legalBasis,
  };
}

function edgeViewOf(row: SuccessionEdgeRow): Record<string, unknown> {
  return {
    id: row.id,
    predecessor_record_id: row.predecessorRecordId,
    predecessor_key: row.predecessorKey,
    predecessor_label: row.predecessorLabel,
    successor_record_id: row.successorRecordId,
    successor_key: row.successorKey,
    successor_label: row.successorLabel,
    master_type: row.masterType,
    succession_kind: row.kind,
    effective_date: row.effectiveDate,
    share_pct: row.sharePct,
    legal_basis: row.legalBasis,
    change_request_id: row.changeRequestId,
  };
}

function targetViewOf(row: SuccessionTarget): Record<string, unknown> {
  return {
    record_id: row.recordId,
    master_type: row.masterType,
    business_key: row.businessKey,
    succession_kind: row.kind,
    effective_date: row.effectiveDate,
    share_pct: row.sharePct,
    in_force: row.version !== null,
    version: row.version === null ? null : versionViewOf(row.version),
  };
}

function readingViewOf(row: StructureReading): Record<string, unknown> {
  return {
    master_record_id: row.recordId,
    master_type: row.masterType,
    business_key: row.businessKey,
    namespace: row.namespace,
    as_of: row.asOf,
    state: row.state,
    structure_date: row.structureDate,
    version: row.version === null ? null : versionViewOf(row.version),
    predecessors: row.predecessors.map(edgeViewOf),
    successors: row.successors.map(edgeViewOf),
    targets: row.targets.map(targetViewOf),
  };
}

/**
 * Administrative succession (ST-MDM-009, MDM 3.1 F3). Recording an edge opens a SUCCESSION change request that is submitted, decided by a
 * second person and published by a third like every other master data change (the generic operations of the change request); the edges
 * become facts at the publication.
 */
@Controller()
export class MasterSuccessionController {
  private readonly store = new MasterSuccessionStore();

  @Post('master-successions')
  @HttpCode(200)
  @OperationId('recordMasterSuccession')
  @Command({ operation: 'recordMasterSuccession' })
  async record(@Scope() scope: CommandScope, @Body() body: Schemas['MdmSuccession']): Promise<CommandResult> {
    const predecessor = asUuid(body.predecessor_record_id);
    const successor = asUuid(body.successor_record_id);
    if (predecessor === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'predecessor_record_id');
    if (successor === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'successor_record_id');
    const recorded = await this.store.record(
      scope.tx,
      {
        predecessorRecordId: predecessor,
        successorRecordId: successor,
        kind: body.succession_kind,
        effectiveDate: dateOf(body.effective_date, 'effective_date'),
        sharePct: body.share_pct,
        legalBasis: body.legal_basis,
        reason: body.reason,
      },
      scope.tenant.membershipId,
    );
    await scope.audit({
      action: 'master.succession_recorded',
      resourceType: CHANGE_RESOURCE_TYPE,
      resourceId: recorded.changeRequestId,
      reason: body.reason,
      diff: {
        predecessor_record_id: predecessor,
        successor_record_id: successor,
        succession_kind: body.succession_kind,
        effective_date: body.effective_date,
        share_pct: body.share_pct ?? null,
        legal_basis: body.legal_basis,
        edges: recorded.edges,
      },
    });
    return commandResult(scope, 'DRAFT', recorded.version, recorded.changeRequestId);
  }
}

/** The reads of the structure: an entry as it stood on a date, and the entries of that date's structure it was converted into. */
@Controller()
export class MasterSuccessionReadsController {
  private readonly store = new MasterSuccessionStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('master-records/:id/as-of')
  @OperationId('getMasterRecordAsOf')
  async asOf(@CurrentTenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Query('date') date?: unknown): Promise<Record<string, unknown>> {
    const on = date === undefined ? vietnamDateOf(new Date()) : dateOf(date, 'date');
    const reading = await this.database.withTenant(tenant, (tx) => this.store.asOf(tx, id, on));
    if (reading === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return readingViewOf(reading);
  }

  @Get('master-records/:id/successors')
  @OperationId('getMasterRecordSuccessors')
  async successors(@CurrentTenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Query('date') date?: unknown): Promise<Record<string, unknown>> {
    const on = date === undefined ? vietnamDateOf(new Date()) : dateOf(date, 'date');
    const found = await this.database.withTenant(tenant, (tx) => this.store.successors(tx, id, on));
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return {
      master_record_id: found.record.id,
      master_type: found.record.masterType,
      business_key: found.record.businessKey,
      as_of: on,
      edges: found.edges.map(edgeViewOf),
      targets: found.targets.map(targetViewOf),
    };
  }
}
