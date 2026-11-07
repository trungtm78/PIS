import { Body, Controller, Get, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { CtrMeasurementStore, TenantDatabase, contractScope } from '@machvon/db';
import type { ContractScopes, CtrMeasurementResult } from '@machvon/db';
import { DomainError, asUuid, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import { enforceSod } from '../../sod-gate';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { measurementActionsOf, measurementView } from './measurement-view';
import type { MeasurementPermissions } from './measurement-view';

const RECORD_PERMISSION = PERMISSIONS.recordMeasurement;
const SUBMIT_PERMISSION = PERMISSIONS.submitMeasurement;
const DECIDE_PERMISSION = PERMISSIONS.post_measurements_id_decision;
const CORRECT_PERMISSION = PERMISSIONS.correctMeasurement;
const READ_PERMISSION = PERMISSIONS.get_resources_measurement;
const RESOURCE_TYPE = 'measurement';
const CLASSIFICATION = 'INTERNAL';

const ACTION_PERMISSIONS: MeasurementPermissions = { submit: SUBMIT_PERMISSION, decide: DECIDE_PERMISSION, correct: CORRECT_PERMISSION };

const scopesFor = (access: EffectiveAccess, permission: string, now: Date): ContractScopes => ({ update: contractScope(access, permission, now), read: contractScope(access, READ_PERMISSION, now) });

/**
 * The quantities of work done under a contract (ST-CTR-008, CTR 3.4). The contractor (a guest, in its own contract) or the supervisor records the quantity of one BOQ item in one period, under
 * the revision in force: the total never goes above the quantity of the item (422 `QUANTITY_EXCEEDS_BOQ`), a period never takes quantity away (422 `CUMULATIVE_DECREASE_WITHOUT_CORRECTION`),
 * a number of record is used once in a contract (409 `MEASUREMENT_REFERENCE_DUPLICATE`), and a construction contract waits for the permits of the start of construction (422
 * `PERMIT_GATE_BLOCKED`). The measurement is sent with its evidence and approved by someone other than whoever recorded or sent it; an approved one is corrected, never edited, unless an active
 * acceptance holds it (409 `MEASUREMENT_IN_ACTIVE_ACCEPTANCE`).
 */
@Controller()
export class MeasurementController {
  private readonly measurements = new CtrMeasurementStore();

  /** For the trace of a refused attempt of the separation-of-duties gate (G4-1); without it the refusal is still enforced, only its separate trace is not written. */
  constructor(@Optional() @Inject(TenantDatabase) private readonly database?: TenantDatabase) {}

  @Post('contracts/:id/measurements')
  @HttpCode(200)
  @OperationId('recordMeasurement')
  @Command({ operation: 'recordMeasurement' })
  async record(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['CtrRecordMeasurement']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.measurements.record(
      scope.tx,
      id.toLowerCase(),
      {
        contractRevisionId: body.contract_revision_id,
        boqItemId: body.boq_item_id,
        partyId: body.party_id,
        periodId: body.period_id,
        quantityPeriod: body.quantity_period,
        referenceNo: body.reference_no,
        duplicateOverrideReason: body.duplicate_override_reason,
        evidenceRefs: body.evidence_refs,
        inspectionId: body.inspection_id,
      },
      scope.tenant.membershipId,
      scopesFor(access, RECORD_PERMISSION, now),
      vietnamDateOf(now),
    );
    await this.written(scope, done, 'measurement.recorded', 'ctr.measurement.recorded.v1', now, {
      contract_revision_id: body.contract_revision_id.toLowerCase(),
      duplicate_override: body.duplicate_override_reason !== undefined,
    });
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('measurements/:id/submit')
  @HttpCode(200)
  @OperationId('submitMeasurement')
  @Command({ operation: 'submitMeasurement', versioned: true })
  async submit(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['CtrSubmitMeasurement']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.measurements.submit(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, scope.tenant.membershipId, scopesFor(access, SUBMIT_PERMISSION, now));
    await this.written(scope, done, 'measurement.submitted', 'ctr.measurement.submitted.v1', now, { evidence_ids: done.evidenceIds }, body.note);
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('measurements/:id/decision')
  @HttpCode(200)
  @OperationId('post_measurements_id_decision')
  @Command({ operation: 'post_measurements_id_decision', versioned: true })
  async decide(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['Decision']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.measurements.decide(
      scope.tx,
      id.toLowerCase(),
      scope.expectedVersion ?? 0,
      { decision: body.decision, reason: body.reason, evidenceIds: body.evidence_ids },
      scope.tenant.membershipId,
      scopesFor(access, DECIDE_PERMISSION, now),
    );
    // G4-1: deciding is the approval duty of the separation-of-duties matrix (a refusal rolls the decision back).
    await enforceSod(scope, this.database, { taking: 'measurement.approve', subjectKind: 'measurement', recordId: done.id, command: 'post_measurements_id_decision' }, now);
    const action = done.decision === 'approve' ? 'approved' : done.decision === 'return' ? 'returned' : 'rejected';
    await this.written(scope, done, `measurement.${action}`, `ctr.measurement.${action}.v1`, now, { decision: done.decision, evidence_ids: done.evidenceIds }, done.reason);
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('measurements/:id/correct')
  @HttpCode(200)
  @OperationId('correctMeasurement')
  @Command({ operation: 'correctMeasurement', versioned: true })
  async correct(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['CtrCorrectMeasurement']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.measurements.correct(
      scope.tx,
      id.toLowerCase(),
      scope.expectedVersion ?? 0,
      { quantityPeriod: body.quantity_period, correctionReason: body.correction_reason, evidenceRefs: body.evidence_refs },
      scope.tenant.membershipId,
      scopesFor(access, CORRECT_PERMISSION, now),
    );
    await this.written(scope, done, 'measurement.corrected', 'ctr.measurement.corrected.v1', now, { superseded_id: done.correctionOfId }, body.correction_reason);
    return commandResult(scope, done.status, done.version, done.id);
  }

  /** The audit row and the event of a command: ids, codes, quantities and statuses, never the words of the reason beyond the row that keeps them. */
  private async written(scope: CommandScope, done: CtrMeasurementResult, action: string, type: string, now: Date, extra: Record<string, unknown>, reason?: string): Promise<void> {
    const facts = {
      contract_id: done.contractId,
      contract_code: done.contractCode,
      project_id: done.projectId,
      boq_item_id: done.boqItemId,
      boq_item_key: done.businessKey,
      period_id: done.periodId,
      quantity_period: done.quantityPeriod,
      quantity_cumulative: done.quantityCumulative,
      remaining_quantity: done.remainingQuantity,
      revision: done.revision,
      reference_no: done.referenceNo,
      correction_of_id: done.correctionOfId,
    };
    await scope.audit({
      action,
      resourceType: RESOURCE_TYPE,
      resourceId: done.id,
      classification: CLASSIFICATION,
      ...(reason === undefined ? {} : { reason }),
      diff: { from_status: done.fromStatus, to_status: done.status, ...facts, ...extra },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: done.id,
      aggregateVersion: done.version,
      type,
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, measurement_id: done.id, ...facts, status: done.status, from_status: done.fromStatus, version: done.version, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString(), ...extra },
      eventKey: `${RESOURCE_TYPE}:${done.id}:${done.version}`,
    });
  }
}

/**
 * The measurements of the contracts in the scope of the caller (the right to read them is `measurement.read`; a guest contractor holds it over its own contract). A draft is seen by whoever
 * recorded it until it is sent.
 */
@Controller('resources/measurement')
export class MeasurementReadsController {
  private readonly measurements = new CtrMeasurementStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  @OperationId('get_resources_measurement')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
    @Query('contract_id') contractId?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const filter = contractId === undefined ? undefined : typeof contractId === 'string' ? asUuid(contractId) : undefined;
    if (contractId !== undefined && filter === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'contract_id');
    const request = parsePageRequest(limit, cursor);
    const now = new Date();
    const rows = await this.database.withTenant(tenant, (tx) =>
      this.measurements.list(tx, contractScope(access, READ_PERMISSION, now), tenant.membershipId, {
        contractId: filter?.toLowerCase(),
        limit: request.limit + 1,
        after: request.after === undefined ? undefined : { createdAt: request.after.code, id: request.after.id },
      }),
    );
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map((line) => measurementView(line, measurementActionsOf(line, access, now, ACTION_PERMISSIONS, tenant.membershipId))),
      // The ordering key of the page is the creation time and the id, which the store compares as a pair.
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.createdAt, id: last.id }) : null,
      as_of: now.toISOString(),
    };
  }

  @Get(':id')
  @OperationId('get_resources_measurement_id')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = new Date();
    const line = await this.database.withTenant(tenant, (tx) => this.measurements.find(tx, id.toLowerCase(), contractScope(access, READ_PERMISSION, now), tenant.membershipId));
    // A measurement in another tenant, outside the scope of the caller, or a draft of someone else is indistinguishable from one that does not exist.
    if (line === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return measurementView(line, measurementActionsOf(line, access, now, ACTION_PERMISSIONS, tenant.membershipId));
  }
}
