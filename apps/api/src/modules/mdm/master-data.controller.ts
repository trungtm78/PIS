import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { MasterStore, TenantDatabase } from '@machvon/db';
import type { ChangeRequestRow, MasterContent, MasterSearchRow, MasterVersionRow } from '@machvon/db';
import { DomainError, asUuid, vietnamDateOf } from '@machvon/kernel';
import type { TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';

const RESOURCE_TYPE = 'master_record';
const CHANGE_RESOURCE_TYPE = 'master_change_request';
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TEXT = 100;
const SUPPORTED_CHANGES = new Set(['UPDATE', 'RETIRE']);
const DECISION_ACTIONS = { approve: 'master.change_approved', reject: 'master.change_rejected', return: 'master.change_returned' } as const;

/** A calendar date as the contract writes it; anything else, or a date that does not exist, is 422 naming the parameter. */
function dateOf(value: unknown, name: string): string {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new DomainError('VALIDATION_FAILED', 422, name);
  }
  return value;
}

function textOf(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value === '' || value.length > MAX_TEXT || value.includes('\0')) throw new DomainError('VALIDATION_FAILED', 422, name);
  return value;
}

function contentOf(body: Schemas['MdmRecordProposal']): MasterContent {
  return {
    label: body.label,
    attributes: body.attributes,
    parentRecordId: body.parent_record_id?.toLowerCase() ?? null,
    validFrom: body.valid_from,
    validUntil: body.valid_until ?? null,
    legalBasis: body.legal_basis === undefined || body.legal_basis === '' ? null : body.legal_basis,
  };
}

function searchViewOf(row: MasterSearchRow): Record<string, unknown> {
  return {
    id: row.id,
    namespace: row.namespace,
    master_type: row.masterType,
    business_key: row.businessKey,
    status: row.status,
    label: row.label,
    valid_from: row.validFrom,
    valid_until: row.validUntil,
    version_id: row.versionId,
    open_change_request_id: row.openChangeRequestId,
    version: row.version,
  };
}

function changeViewOf(row: ChangeRequestRow): Record<string, unknown> {
  return {
    id: row.id,
    change_kind: row.changeKind,
    master_type: row.masterType,
    master_record_id: row.masterRecordId,
    status: row.status,
    proposed: row.proposed,
    before: row.before,
    reason: row.reason,
    evidence_document_id: row.evidenceDocumentId,
    impact: row.impact,
    effective_from: row.effectiveFrom,
    created_by: row.createdBy,
    reviewed_by: row.reviewedBy,
    decided_at: row.decidedAt,
    published_by: row.publishedBy,
    decision_document_id: row.decisionDocumentId,
    version: row.version,
  };
}

function versionViewOf(row: MasterVersionRow): Record<string, unknown> {
  return {
    id: row.id,
    master_record_id: row.masterRecordId,
    master_type: row.masterType,
    code: row.code,
    revision: row.revision,
    label: row.label,
    parent_record_id: row.parentRecordId,
    attributes: row.attributes,
    valid_from: row.validFrom,
    valid_until: row.validUntil,
    status: row.status,
    legal_basis: row.legalBasis,
    content_sha256: row.contentSha256,
  };
}

/**
 * Master data commands (ST-MDM-001, MDM 3.1 F1): propose an entry, open a change request, submit it with its impact, decide it
 * (never by its proposer) and publish it (never by its proposer either). History is never rewritten: publishing closes the
 * version in force and starts the next one at the effective date.
 */
@Controller()
export class MasterDataController {
  private readonly store = new MasterStore();

  @Post('master-records')
  @HttpCode(200)
  @OperationId('proposeMasterRecord')
  @Command({ operation: 'proposeMasterRecord' })
  async propose(@Scope() scope: CommandScope, @Body() body: Schemas['MdmRecordProposal']): Promise<CommandResult> {
    // The PLATFORM namespace is published by the platform, not by a tenant (MDM 3.1 F1: PLATFORM is locked).
    if (body.namespace !== 'TENANT') throw new DomainError('POLICY_LOCKED', 403);
    const created = await this.store.propose(
      scope.tx,
      { masterType: body.master_type, businessKey: body.business_key, content: contentOf(body), reason: body.reason, evidenceDocumentId: body.evidence_document_id?.toLowerCase() },
      scope.tenant.membershipId,
    );
    await scope.audit({
      action: 'master.proposed',
      resourceType: RESOURCE_TYPE,
      resourceId: created.recordId,
      reason: body.reason,
      diff: { master_type: body.master_type, business_key: body.business_key, after: { label: body.label, valid_from: body.valid_from, valid_until: body.valid_until ?? null }, change_request_id: created.changeRequestId },
    });
    return commandResult(scope, 'DRAFT', created.version, created.recordId);
  }

  @Post('master-change-requests')
  @HttpCode(200)
  @OperationId('createMasterChangeRequest')
  @Command({ operation: 'createMasterChangeRequest' })
  async createChange(@Scope() scope: CommandScope, @Body() body: Schemas['MdmChangeRequest']): Promise<CommandResult> {
    // RESTRUCTURE and SUCCESSION go through the succession step (MDM-009), which has its own validation.
    if (!SUPPORTED_CHANGES.has(body.change_kind)) throw new DomainError('VALIDATION_FAILED', 422, 'change_kind');
    if (body.master_record_id === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'master_record_id');
    const proposed = body.proposed as Record<string, unknown>;
    const created = await this.store.createChange(
      scope.tx,
      {
        kind: body.change_kind as 'UPDATE' | 'RETIRE',
        masterType: body.master_type,
        masterRecordId: body.master_record_id.toLowerCase(),
        proposed: {
          ...(typeof proposed.label === 'string' ? { label: proposed.label } : {}),
          ...(typeof proposed.attributes === 'object' && proposed.attributes !== null && !Array.isArray(proposed.attributes) ? { attributes: proposed.attributes as Record<string, unknown> } : {}),
          ...(typeof proposed.parent_record_id === 'string' || proposed.parent_record_id === null ? { parentRecordId: proposed.parent_record_id } : {}),
          ...(typeof proposed.valid_until === 'string' || proposed.valid_until === null ? { validUntil: proposed.valid_until } : {}),
          ...(typeof proposed.legal_basis === 'string' || proposed.legal_basis === null ? { legalBasis: proposed.legal_basis } : {}),
        },
        effectiveFrom: body.effective_from,
        reason: body.reason,
        evidenceDocumentId: body.evidence_document_id?.toLowerCase(),
        successorRecordId: body.successor_record_id?.toLowerCase(),
      },
      scope.tenant.membershipId,
    );
    await scope.audit({
      action: 'master.change_created',
      resourceType: CHANGE_RESOURCE_TYPE,
      resourceId: created.id,
      reason: body.reason,
      diff: { change_kind: body.change_kind, master_record_id: body.master_record_id, effective_from: body.effective_from },
    });
    return commandResult(scope, 'DRAFT', created.version, created.id);
  }

  @Post('master-change-requests/:id/submit')
  @HttpCode(200)
  @OperationId('submitMasterChangeRequest')
  @Command({ operation: 'submitMasterChangeRequest', versioned: true })
  async submit(@Scope() scope: CommandScope, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    const submitted = await this.store.submit(scope.tx, id, scope.expectedVersion ?? 0, scope.tenant.membershipId);
    await scope.audit({
      action: 'master.change_submitted',
      resourceType: CHANGE_RESOURCE_TYPE,
      resourceId: id,
      reason: submitted.change.reason,
      diff: { change_kind: submitted.change.changeKind, master_record_id: submitted.change.masterRecordId, before: submitted.change.before, after: submitted.change.proposed, impact: submitted.impact },
    });
    await scope.emit({
      aggregateType: CHANGE_RESOURCE_TYPE,
      aggregateId: id,
      aggregateVersion: submitted.version,
      type: 'master.change_submitted.v1',
      schemaVersion: 1,
      payload: { change_request_id: id, master_type: submitted.change.masterType, change_kind: submitted.change.changeKind, impact_total: submitted.impact.total },
      eventKey: `${CHANGE_RESOURCE_TYPE}:${id}:${submitted.version}`,
    });
    return commandResult(scope, 'IN_REVIEW', submitted.version, id);
  }

  @Post('master-change-requests/:id/decision')
  @HttpCode(200)
  @OperationId('decideMasterChangeRequest')
  @Command({ operation: 'decideMasterChangeRequest', versioned: true })
  async decide(@Scope() scope: CommandScope, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['MdmDecision']): Promise<CommandResult> {
    const decided = await this.store.decide(scope.tx, id, scope.expectedVersion ?? 0, body.decision, scope.tenant.membershipId);
    await scope.audit({
      action: DECISION_ACTIONS[body.decision],
      resourceType: CHANGE_RESOURCE_TYPE,
      resourceId: id,
      reason: body.reason,
      diff: { change_kind: decided.change.changeKind, master_record_id: decided.change.masterRecordId, decision: body.decision, status: decided.status },
    });
    return commandResult(scope, decided.status, decided.version, id);
  }

  @Post('master-records/:id/publish')
  @HttpCode(200)
  @OperationId('post_master_records_id_publish')
  @Command({ operation: 'post_master_records_id_publish', versioned: true })
  async publish(@Scope() scope: CommandScope, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['CapApplyDecision']): Promise<CommandResult> {
    const published = await this.store.publish(scope.tx, id, scope.expectedVersion ?? 0, body.decision_document_id.toLowerCase(), scope.tenant.membershipId);
    await scope.audit({
      action: 'master.published',
      resourceType: RESOURCE_TYPE,
      resourceId: id,
      reason: published.change.reason,
      diff: {
        change_kind: published.change.changeKind,
        change_request_id: published.change.id,
        before: published.change.before,
        after: published.change.proposed,
        effective_from: published.change.effectiveFrom,
        decision_document_id: body.decision_document_id,
        in_force: published.active,
      },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: id,
      aggregateVersion: published.version,
      type: 'master.published.v1',
      schemaVersion: 1,
      payload: {
        master_record_id: id,
        master_type: published.record.masterType,
        business_key: published.record.businessKey,
        version_id: published.versionId,
        change_kind: published.change.changeKind,
        effective_from: published.change.effectiveFrom,
      },
      eventKey: `${RESOURCE_TYPE}:${id}:${published.version}`,
    });
    return commandResult(scope, published.record.status, published.version, id);
  }
}

/** Reads of master data: the search by type and key, the usage list, the change request and the version scaffold. */
@Controller()
export class MasterDataReadsController {
  private readonly store = new MasterStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('master-records')
  @OperationId('searchMasterRecords')
  async search(
    @CurrentTenant() tenant: TenantContext,
    @Query('master_type') masterType?: unknown,
    @Query('business_key') businessKey?: unknown,
    @Query('namespace') namespace?: unknown,
    @Query('as_of') asOf?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const request = parsePageRequest(limit, cursor);
    if (namespace !== undefined && namespace !== 'PLATFORM' && namespace !== 'TENANT') throw new DomainError('VALIDATION_FAILED', 422, 'namespace');
    const on = asOf === undefined ? vietnamDateOf(new Date()) : dateOf(asOf, 'as_of');
    const rows = await this.database.withTenant(tenant, (tx) =>
      this.store.search(tx, {
        masterType: textOf(masterType, 'master_type'),
        businessKey: textOf(businessKey, 'business_key'),
        namespace,
        asOf: on,
        limit: request.limit + 1,
        after: request.after,
      }),
    );
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map(searchViewOf),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: `${last.masterType}:${last.businessKey}`, id: last.id }) : null,
      as_of: on,
    };
  }

  @Get('master-records/:id/usages')
  @OperationId('getMasterRecordUsages')
  async usages(@CurrentTenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Query('as_of') asOf?: unknown): Promise<Record<string, unknown>> {
    const on = asOf === undefined ? undefined : dateOf(asOf, 'as_of');
    const usage = await this.database.withTenant(tenant, async (tx) => {
      if ((await this.store.findRecord(tx, id)) === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      return this.store.usage(tx, id, on);
    });
    return { master_record_id: usage.masterRecordId, as_of: usage.asOf, counts: usage.counts, total: usage.total, samples: usage.samples };
  }

  @Get('master-change-requests/:id')
  @OperationId('getMasterChangeRequest')
  async change(@CurrentTenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const row = await this.database.withTenant(tenant, (tx) => this.store.findChange(tx, id));
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return changeViewOf(row);
  }

  @Get('resources/master_record_version')
  @OperationId('get_resources_master_record_version')
  async versions(
    @CurrentTenant() tenant: TenantContext,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
    @Query('master_record_id') masterRecordId?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const request = parsePageRequest(limit, cursor);
    const record = masterRecordId === undefined ? undefined : asUuid(masterRecordId);
    if (masterRecordId !== undefined && record === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'master_record_id');
    const rows = await this.database.withTenant(tenant, (tx) => this.store.listVersions(tx, { limit: request.limit + 1, after: request.after, masterRecordId: record }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map(versionViewOf),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: `${last.masterType}:${last.code}:${String(last.revision).padStart(9, '0')}`, id: last.id }) : null,
      as_of: new Date().toISOString(),
    };
  }

  @Get('resources/master_record_version/:id')
  @OperationId('get_resources_master_record_version_id')
  async version(@CurrentTenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const row = await this.database.withTenant(tenant, (tx) => this.store.findVersion(tx, id));
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return versionViewOf(row);
  }
}
