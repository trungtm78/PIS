import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { MATERIAL_TEST_RESOURCE, QmsMaterialStore, TenantDatabase, contractScope } from '@machvon/db';
import type { ContractScopes, MaterialTestLine, QmsMaterialTestResult } from '@machvon/db';
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
import { placeRefs, reaches } from '../ctr/contract.controller';

const MANAGE_PERMISSION = PERMISSIONS.registerMaterialTest;
const RECORD_PERMISSION = PERMISSIONS.recordMaterialTestResult;
const READ_PERMISSION = PERMISSIONS.listMaterialTests;
const CLASSIFICATION = 'INTERNAL';
const NCR_RESOURCE = 'nonconformance';

const scopesFor = (access: EffectiveAccess, permission: string, now: Date): ContractScopes => ({ update: contractScope(access, permission, now), read: contractScope(access, READ_PERMISSION, now) });

/** A test as openapi.json exposes it (x-exposure dto): an allowlist; the caller may record a result on a test that only waits for one, over the contract. */
export function materialTestView(line: MaterialTestLine, access: EffectiveAccess, now: Date): Record<string, unknown> {
  return {
    id: line.id,
    contract: { id: line.contract.id, code: line.contract.code },
    project_id: line.projectId,
    boq_item_id: line.boqItemId,
    sample_code: line.sampleCode,
    material_kind: line.materialKind,
    lab_name: line.labName,
    standard_ref: line.standardRef,
    sampled_on: line.sampledOn,
    tested_on: line.testedOn,
    result: line.result,
    result_values: line.resultValues,
    report_document_version_id: line.reportDocumentVersionId,
    status: line.status,
    nonconformance: line.nonconformance === null ? null : { id: line.nonconformance.id, ncr_no: line.nonconformance.ncrNo, severity: line.nonconformance.severity, status: line.nonconformance.status },
    created_at: line.createdAt,
    allowed: { record: line.status === 'REGISTERED' && reaches(access, RECORD_PERMISSION, placeRefs(line.reach), now) },
    version: line.version,
  };
}

/**
 * The testing of materials (ST-QMS-007, QMS 3.3, UC-QMS-03, UAT-AC362). A supervisor registers a sample against a contract being performed (409 `SAMPLE_CODE_DUPLICATE`); the result of the laboratory is recorded
 * once with its day, its values and a report that is a clean file (422 `DOCUMENT_NOT_CLEAN`, 409 `MATERIAL_TEST_STATE_INVALID` for a test that has its result). A result that failed raises a non-conformance of
 * the test in the same transaction and the test keeps it; a result that passed raises none.
 */
@Controller()
export class MaterialController {
  private readonly materials = new QmsMaterialStore();

  @Post('material-tests')
  @HttpCode(200)
  @OperationId('registerMaterialTest')
  @Command({ operation: 'registerMaterialTest' })
  async register(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['QmsRegisterMaterialTest']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.materials.register(
      scope.tx,
      {
        contractId: body.contract_id,
        boqItemId: body.boq_item_id,
        sampleCode: body.sample_code,
        materialKind: body.material_kind,
        labName: body.lab_name,
        standardRef: body.standard_ref,
        sampledOn: body.sampled_on,
      },
      scope.tenant.membershipId,
      scopesFor(access, MANAGE_PERMISSION, now),
      now,
    );
    await this.written(scope, done, 'material_test.registered', 'qms.material_test.registered.v1', now);
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('material-tests/:id/result')
  @HttpCode(200)
  @OperationId('recordMaterialTestResult')
  @Command({ operation: 'recordMaterialTestResult', versioned: true })
  async record(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['QmsRecordMaterialTestResult'],
  ): Promise<CommandResult> {
    const now = new Date();
    const done = await this.materials.recordResult(
      scope.tx,
      id.toLowerCase(),
      scope.expectedVersion ?? 0,
      { result: body.result, testedOn: body.tested_on, resultValues: body.result_values, reportDocumentVersionId: body.report_document_version_id },
      scope.tenant.membershipId,
      scopesFor(access, RECORD_PERMISSION, now),
      now,
    );
    await this.written(scope, done, 'material_test.result_recorded', 'qms.material_test.result_recorded.v1', now);
    // The non-conformance a failed test raised is announced as any other is: it is what ISS and CTR watch for.
    if (done.nonconformance !== null) await this.ncrRaised(scope, done, now);
    return commandResult(scope, done.status, done.version, done.id);
  }

  /** The audit row and the event of a command: ids, the sample code, the result and the day; the values of the laboratory stay in the table. */
  private async written(scope: CommandScope, done: QmsMaterialTestResult, action: string, type: string, now: Date): Promise<void> {
    const facts = {
      contract_id: done.contractId,
      contract_code: done.contractCode,
      project_id: done.projectId,
      sample_code: done.sampleCode,
      material_kind: done.materialKind,
      standard_ref: done.standardRef,
      sampled_on: done.sampledOn,
      tested_on: done.testedOn,
      result: done.result,
      nonconformance_id: done.nonconformance?.id ?? null,
    };
    await scope.audit({ action, resourceType: MATERIAL_TEST_RESOURCE, resourceId: done.id, classification: CLASSIFICATION, diff: { from_status: done.fromStatus, to_status: done.status, ...facts } });
    await scope.emit({
      aggregateType: MATERIAL_TEST_RESOURCE,
      aggregateId: done.id,
      aggregateVersion: done.version,
      type,
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        material_test_id: done.id,
        ...facts,
        status: done.status,
        from_status: done.fromStatus,
        version: done.version,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
      },
      eventKey: `${MATERIAL_TEST_RESOURCE}:${done.id}:${done.version}`,
    });
  }

  private async ncrRaised(scope: CommandScope, done: QmsMaterialTestResult, now: Date): Promise<void> {
    const ncr = done.nonconformance;
    if (ncr === null) return;
    const facts = {
      ncr_no: ncr.ncrNo,
      contract_id: ncr.contractId,
      contract_code: ncr.contractCode,
      project_id: ncr.projectId,
      severity: ncr.severity,
      source_kind: ncr.sourceKind,
      blocks_acceptance: ncr.blocksAcceptance,
      open_actions: ncr.openActions,
      corrective_action_id: null,
      corrective_action_status: null,
    };
    await scope.audit({
      action: 'nonconformance.raised',
      resourceType: NCR_RESOURCE,
      resourceId: ncr.id,
      classification: CLASSIFICATION,
      reason: 'material_test_failed',
      diff: { from_status: null, to_status: ncr.status, material_test_id: done.id, ...facts },
    });
    await scope.emit({
      aggregateType: NCR_RESOURCE,
      aggregateId: ncr.id,
      aggregateVersion: ncr.version,
      type: 'qms.ncr.raised.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        nonconformance_id: ncr.id,
        ...facts,
        material_test_id: done.id,
        status: ncr.status,
        from_status: null,
        version: ncr.version,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
      },
      eventKey: `${NCR_RESOURCE}:${ncr.id}:${ncr.version}`,
    });
  }
}

/** The material tests of the contracts in the scope of the caller (the right to read them is `material.manage`: the supervisor who registers the samples). */
@Controller('material-tests')
export class MaterialReadsController {
  private readonly materials = new QmsMaterialStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  /** The contracts being performed that the caller can register a sample on: the options of the form, under the right to manage the tests and not under the right to read contracts. */
  @Get('contracts')
  @OperationId('listMaterialContracts')
  async contracts(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const request = parsePageRequest(limit, cursor);
    const now = new Date();
    const rows = await this.database.withTenant(tenant, (tx) => this.materials.contractOptions(tx, contractScope(access, MANAGE_PERMISSION, now), { limit: request.limit + 1, after: request.after }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map((row) => ({ id: row.id, code: row.code, title: row.title, project_id: row.projectId })),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.code, id: last.id }) : null,
      as_of: now.toISOString(),
    };
  }

  @Get()
  @OperationId('listMaterialTests')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
    @Query('contract_id') contractId?: unknown,
    @Query('status') status?: unknown,
    @Query('result') result?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const request = parsePageRequest(limit, cursor);
    const contract = contractId === undefined ? undefined : typeof contractId === 'string' ? asUuid(contractId) : undefined;
    if (contractId !== undefined && contract === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'contract_id');
    for (const [value, field] of [[status, 'status'], [result, 'result']] as const) if (value !== undefined && typeof value !== 'string') throw new DomainError('VALIDATION_FAILED', 422, field);
    const now = new Date();
    const rows = await this.database.withTenant(tenant, (tx) =>
      this.materials.list(tx, contractScope(access, READ_PERMISSION, now), {
        contractId: contract?.toLowerCase(),
        status: status as string | undefined,
        result: result as string | undefined,
        limit: request.limit + 1,
        after: request.after,
      }),
    );
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map((line) => materialTestView(line, access, now)),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.createdAt, id: last.id }) : null,
      as_of: now.toISOString(),
    };
  }
}
