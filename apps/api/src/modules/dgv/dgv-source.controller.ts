import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { DgvMappingStore, DgvReconciliationStore, TenantDatabase } from '@machvon/db';
import type { BatchGateRecord, MappingRecord, ReconciliationRecord } from '@machvon/db';
import { DomainError } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { holdsOnWholeTenant } from '../adm/tenant-authority';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { assertTenantAuthority, textOf, uuidOf, viewerOf } from './inputs';

const MAPPING_RESOURCE = 'dataset_source_mapping';
const RECON_RESOURCE = 'reconciliation_run';
const MAPPING_STATUSES: readonly string[] = ['PROPOSED', 'CONFIRMED', 'REJECTED', 'RETIRED'];
const MAPPING_DECISIONS = ['CONFIRMED', 'REJECTED'] as const;
const RECON_RESULTS: readonly string[] = ['MATCHED', 'WITHIN_TOLERANCE', 'DIFFERENT'];
const GATE_OUTCOMES: readonly string[] = ['APPLIED', 'QUARANTINED'];

function oneOf(list: readonly string[], value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !list.includes(value)) throw new DomainError('VALIDATION_FAILED', 422, name);
  return value;
}

/** A text of a body that must say something: normalised, trimmed, at least `min` characters. */
function textField(value: unknown, name: string, min: number, max: number): string {
  if (typeof value !== 'string') throw new DomainError('VALIDATION_FAILED', 422, name);
  const text = value.normalize('NFC').trim();
  if (text.length < min || text.length > max || text.includes('\0')) throw new DomainError('VALIDATION_FAILED', 422, name);
  return text;
}

function optionalText(value: unknown, name: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = textField(value, name, 0, max);
  return text === '' ? undefined : text;
}

function mappingView(mapping: MappingRecord, access: EffectiveAccess, membershipId: string): Record<string, unknown> {
  return {
    id: mapping.id,
    dataset: { id: mapping.datasetId, code: mapping.datasetCode },
    source_system: mapping.sourceSystem,
    source_field: mapping.sourceField,
    target_field: mapping.targetField,
    transform_rule: mapping.transformRule,
    unit: mapping.unit,
    status: mapping.status,
    proposed_by: { id: mapping.proposedBy, name: mapping.proposedByName },
    decided_by: mapping.decidedBy === null ? null : { id: mapping.decidedBy, name: mapping.decidedByName },
    decided_at: mapping.decidedAt,
    decision_note: mapping.decisionNote,
    created_at: mapping.createdAt,
    version: mapping.version,
    // Whoever proposed a mapping does not confirm it; the server judges the command again.
    actions: { decide: mapping.status === 'PROPOSED' && mapping.proposedBy !== membershipId && holdsOnWholeTenant(access, PERMISSIONS.decideSourceMapping) },
  };
}

function gateView(gate: BatchGateRecord): Record<string, unknown> {
  return { id: gate.id, dataset_id: gate.datasetId, source_system: gate.sourceSystem, batch_ref: gate.batchRef, outcome: gate.outcome, reason: gate.reason, row_count: gate.rowCount, fields: gate.fields, gated_at: gate.gatedAt, gated_by: gate.gatedBy };
}

/** The reconciliation as the reads show it; the list leaves out the differences one by one (they are read on the one that is opened). */
function reconView(recon: ReconciliationRecord, detail: boolean): Record<string, unknown> {
  return {
    id: recon.id,
    recon_code: recon.reconCode,
    source_a: recon.sourceA,
    source_b: recon.sourceB,
    as_of_period: recon.asOfPeriod,
    basis: recon.basis,
    count_a: recon.countA,
    count_b: recon.countB,
    // The two totals stay apart: neither is chosen as the right one and the difference is only the difference.
    total_a_vnd: recon.totalAVnd,
    total_b_vnd: recon.totalBVnd,
    difference_vnd: recon.differenceVnd,
    tolerance_vnd: recon.toleranceVnd,
    result: recon.result,
    differences_count: recon.differencesCount,
    differences_truncated: recon.differencesTruncated,
    by_kind: recon.byKind,
    owner: { id: recon.ownerId, name: recon.ownerName },
    dataset_id: recon.datasetId,
    incident_id: recon.incidentId,
    created_at: recon.createdAt,
    ...(detail ? { differences: recon.differences } : {}),
  };
}

/**
 * The commands on the mappings of the fields of a source (ST-DGV-004, DGV.md F7): a steward proposes a mapping with the unit the source writes the field in, somebody else confirms or rejects it. The pipeline reads only the
 * confirmed ones. Datasets belong to no unit, so the rights are held on the whole tenant.
 */
@Controller()
export class DgvMappingCommandsController {
  private readonly mappings = new DgvMappingStore();

  @Post('dgv/source-mappings')
  @HttpCode(200)
  @OperationId('proposeSourceMapping')
  @Command({ operation: 'proposeSourceMapping' })
  async propose(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['DgvMappingPropose']): Promise<CommandResult> {
    assertTenantAuthority(access, PERMISSIONS.proposeSourceMapping);
    const input = {
      datasetId: uuidOf(body.dataset_id, 'dataset_id'),
      sourceSystem: textField(body.source_system, 'source_system', 2, 120),
      sourceField: textField(body.source_field, 'source_field', 1, 200),
      targetField: textField(body.target_field, 'target_field', 1, 200),
      transformRule: optionalText(body.transform_rule, 'transform_rule', 2000),
      unit: optionalText(body.unit, 'unit', 40),
    };
    const created = await this.mappings.propose(scope.tx, viewerOf(scope.tenant, access), input);
    await scope.audit({
      action: 'dgv.source_mapping_proposed',
      resourceType: MAPPING_RESOURCE,
      resourceId: created.id,
      diff: { dataset_id: input.datasetId, source_system: input.sourceSystem, source_field: input.sourceField, target_field: input.targetField, unit: input.unit ?? null },
    });
    await scope.emit({
      aggregateType: MAPPING_RESOURCE,
      aggregateId: created.id,
      aggregateVersion: 1,
      type: 'dgv.mapping.proposed.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, mapping_id: created.id, dataset_id: input.datasetId, source_system: input.sourceSystem, version: 1, actor_id: scope.tenant.membershipId, occurred_at: new Date().toISOString() },
      eventKey: `${MAPPING_RESOURCE}:${created.id}:1`,
    });
    return commandResult(scope, 'PROPOSED', 1, created.id);
  }

  @Post('dgv/source-mappings/:id/decision')
  @HttpCode(200)
  @OperationId('decideSourceMapping')
  @Command({ operation: 'decideSourceMapping', versioned: true })
  async decide(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['DgvMappingDecision']): Promise<CommandResult> {
    assertTenantAuthority(access, PERMISSIONS.decideSourceMapping);
    const decision = MAPPING_DECISIONS.find((candidate) => candidate === body.decision);
    if (decision === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'decision');
    const note = optionalText(body.note, 'note', 1000);
    const decided = await this.mappings.decide(scope.tx, viewerOf(scope.tenant, access), { id: id.toLowerCase(), expectedVersion: scope.expectedVersion ?? 0, decision, note, at: new Date() });
    await scope.audit({
      action: 'dgv.source_mapping_decided',
      resourceType: MAPPING_RESOURCE,
      resourceId: decided.id,
      ...(note === undefined ? {} : { reason: note }),
      diff: { decision, dataset_id: decided.datasetId, source_system: decided.sourceSystem, source_field: decided.sourceField, target_field: decided.targetField, proposed_by: decided.proposedBy, retired_mapping_ids: decided.retiredIds },
    });
    await scope.emit({
      aggregateType: MAPPING_RESOURCE,
      aggregateId: decided.id,
      aggregateVersion: decided.version,
      type: 'dgv.mapping.decided.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, mapping_id: decided.id, dataset_id: decided.datasetId, decision, retired_mapping_ids: decided.retiredIds, version: decided.version, actor_id: scope.tenant.membershipId, occurred_at: new Date().toISOString() },
      eventKey: `${MAPPING_RESOURCE}:${decided.id}:${decided.version}`,
    });
    return commandResult(scope, decision, decided.version, decided.id);
  }
}

/** The mappings, and the batches the gate let through or kept out: those of the datasets the viewer may see. */
@Controller('dgv')
export class DgvMappingReadsController {
  private readonly mappings = new DgvMappingStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('source-mappings')
  @OperationId('listSourceMappings')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('dataset_id') datasetId?: unknown,
    @Query('status') status?: unknown,
    @Query('source_system') sourceSystem?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const request = parsePageRequest(limit, cursor);
    const filters = { datasetId: datasetId === undefined ? undefined : uuidOf(datasetId, 'dataset_id'), status: oneOf(MAPPING_STATUSES, status, 'status'), sourceSystem: textOf(sourceSystem, 'source_system') };
    const viewer = viewerOf(tenant, access);
    const rows = await this.database.withTenant(tenant, (tx) => this.mappings.list(tx, viewer, filters, { limit: request.limit + 1, after: request.after }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map((mapping) => mappingView(mapping, access, tenant.membershipId)),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.sortKey, id: last.id }) : null,
      as_of: new Date().toISOString(),
    };
  }

  @Get('batch-gates')
  @OperationId('listBatchGates')
  async gates(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('dataset_id') datasetId?: unknown,
    @Query('outcome') outcome?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const request = parsePageRequest(limit, cursor);
    const filters = { datasetId: datasetId === undefined ? undefined : uuidOf(datasetId, 'dataset_id'), outcome: oneOf(GATE_OUTCOMES, outcome, 'outcome') };
    const viewer = viewerOf(tenant, access);
    const rows = await this.database.withTenant(tenant, (tx) => this.mappings.listGates(tx, viewer, filters, { limit: request.limit + 1, after: request.after }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return { items: shown.map(gateView), next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.sortKey, id: last.id }) : null, as_of: new Date().toISOString() };
  }
}

/**
 * The reconciliation of the Treasury of PAY with the report DIS accepted for a month (ST-DGV-004, DGV.md F7, BR-DGV-09). It reads both on the same period and basis, project by project, and keeps every difference with its kind;
 * a difference opens one incident for the owner of the dataset. The amounts are those of every project of the tenant, so both the command and the reads need the right on the whole tenant.
 */
@Controller('dgv/reconciliations')
export class DgvReconciliationController {
  private readonly reconciliations = new DgvReconciliationStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Post()
  @HttpCode(202)
  @OperationId('runReconciliation')
  @Command({ operation: 'runReconciliation' })
  async run(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['DgvReconRequest']): Promise<CommandResult> {
    assertTenantAuthority(access, PERMISSIONS.runReconciliation);
    const tolerance = typeof body.tolerance_vnd === 'string' && /^[0-9]{1,24}$/.test(body.tolerance_vnd) ? body.tolerance_vnd : undefined;
    if (tolerance === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'tolerance_vnd');
    const input = {
      reconCode: textField(body.recon_code, 'recon_code', 2, 80),
      sourceA: textField(body.source_a, 'source_a', 2, 200),
      sourceB: textField(body.source_b, 'source_b', 2, 200),
      asOfPeriod: textField(body.as_of_period, 'as_of_period', 4, 20),
      basis: textField(body.basis, 'basis', 2, 200),
      toleranceVnd: tolerance,
      datasetId: body.dataset_id === undefined ? undefined : uuidOf(body.dataset_id, 'dataset_id'),
      at: new Date(),
    };
    const recon = await this.reconciliations.run(scope.tx, viewerOf(scope.tenant, access), input);
    // The audit and the event name the figures that matter (totals, counts by kind) and the incident; the projects stay in the reconciliation.
    const facts = { recon_code: recon.reconCode, as_of_period: recon.asOfPeriod, result: recon.result, total_a_vnd: recon.totalAVnd, total_b_vnd: recon.totalBVnd, differences: recon.differencesCount, by_kind: recon.byKind, incident_id: recon.incidentId, dataset_id: recon.datasetId };
    await scope.audit({ action: 'dgv.reconciliation_run', resourceType: RECON_RESOURCE, resourceId: recon.id, diff: facts });
    await scope.emit({
      aggregateType: RECON_RESOURCE,
      aggregateId: recon.id,
      aggregateVersion: 1,
      type: 'dgv.reconciliation.completed.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, reconciliation_id: recon.id, ...facts, version: 1, actor_id: scope.tenant.membershipId, occurred_at: input.at.toISOString() },
      eventKey: `${RECON_RESOURCE}:${recon.id}:1`,
    });
    return commandResult(scope, recon.result, 1, recon.id);
  }

  @Get()
  @OperationId('listReconciliations')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('recon_code') reconCode?: unknown,
    @Query('as_of_period') period?: unknown,
    @Query('result') result?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    assertTenantAuthority(access, PERMISSIONS.listReconciliations);
    const request = parsePageRequest(limit, cursor);
    const filters = { reconCode: textOf(reconCode, 'recon_code'), period: textOf(period, 'as_of_period'), result: oneOf(RECON_RESULTS, result, 'result') };
    const viewer = viewerOf(tenant, access);
    const rows = await this.database.withTenant(tenant, (tx) => this.reconciliations.list(tx, viewer, filters, { limit: request.limit + 1, after: request.after }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map((recon) => reconView(recon, false)),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.sortKey, id: last.id }) : null,
      as_of: new Date().toISOString(),
    };
  }

  @Get(':id')
  @OperationId('getReconciliation')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    assertTenantAuthority(access, PERMISSIONS.getReconciliation);
    const viewer = viewerOf(tenant, access);
    const recon = await this.database.withTenant(tenant, (tx) => this.reconciliations.find(tx, viewer, id.toLowerCase()));
    if (recon === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { ...reconView(recon, true), as_of: new Date().toISOString() };
  }
}
