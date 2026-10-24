import { Controller, Get, Inject, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { RetentionPolicyStore, RetentionReviewStore, TenantDatabase } from '@machvon/db';
import type { RetentionPolicyRow, ReviewItemRow } from '@machvon/db';
import { DomainError } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { holdsOnWholeTenant } from './tenant-authority';

const POLICY_PERMISSION = PERMISSIONS.get_resources_data_retention_policy;
const REVIEW_PERMISSION = PERMISSIONS.get_resources_retention_review_item;

type Page = { items: Array<Record<string, unknown>>; next_cursor: string | null };

/** openapi.json get_resources_data_retention_policy item: a version of the retention rule of a record class. */
function policyViewOf(row: RetentionPolicyRow): Record<string, unknown> {
  return {
    id: row.id,
    record_class: row.recordClass,
    revision: row.revision,
    retention_years: row.retentionYears,
    retention_basis: row.retentionBasis,
    legal_basis_ref: row.legalBasisRef,
    end_action: row.endAction,
    effective_from: row.effectiveFrom,
    status: row.status,
    created_by: row.createdBy,
    approved_by: row.approvedBy,
    published_at: row.publishedAt,
    version: row.version,
  };
}

/** openapi.json get_resources_retention_review_item item: a record that waits for a decision. */
function reviewViewOf(row: ReviewItemRow): Record<string, unknown> {
  return {
    id: row.id,
    record_class: row.recordClass,
    resource_type: row.resourceType,
    resource_id: row.resourceId,
    basis_date: row.basisDate,
    due_on: row.dueOn,
    end_action: row.endAction,
    status: row.status,
  };
}

/**
 * Reads of the retention policy versions (ST-ADM-017, ADM-12): by class, the newest revision first, for the whole tenant. Retention rules
 * are tenant administration, so only a grant on the whole tenant reads them (anyone else sees an empty list and 404).
 */
@Controller('resources/data_retention_policy')
export class RetentionPolicyReadsController {
  private readonly store = new RetentionPolicyStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  @OperationId('get_resources_data_retention_policy')
  async list(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('limit') limit?: unknown, @Query('cursor') cursor?: unknown): Promise<Page> {
    const request = parsePageRequest(limit, cursor);
    if (!holdsOnWholeTenant(access, POLICY_PERMISSION)) return { items: [], next_cursor: null };
    const rows = await this.database.withTenant(tenant, (tx) => this.store.list(tx, { limit: request.limit + 1, after: request.after }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return { items: shown.map(policyViewOf), next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor(this.store.cursorOf(last)) : null };
  }

  @Get(':id')
  @OperationId('get_resources_data_retention_policy_id')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    if (!holdsOnWholeTenant(access, POLICY_PERMISSION)) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const row = await this.database.withTenant(tenant, (tx) => this.store.find(tx, id));
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return policyViewOf(row);
  }
}

/** Reads of the review list (ST-ADM-017, ADM-12): the oldest expired first, for the whole tenant. */
@Controller('resources/retention_review_item')
export class RetentionReviewReadsController {
  private readonly store = new RetentionReviewStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  @OperationId('get_resources_retention_review_item')
  async list(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('limit') limit?: unknown, @Query('cursor') cursor?: unknown): Promise<Page> {
    const request = parsePageRequest(limit, cursor);
    if (!holdsOnWholeTenant(access, REVIEW_PERMISSION)) return { items: [], next_cursor: null };
    const rows = await this.database.withTenant(tenant, (tx) => this.store.list(tx, { limit: request.limit + 1, after: request.after }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return { items: shown.map(reviewViewOf), next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.dueOn, id: last.id }) : null };
  }

  @Get(':id')
  @OperationId('get_resources_retention_review_item_id')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    if (!holdsOnWholeTenant(access, REVIEW_PERMISSION)) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const row = await this.database.withTenant(tenant, (tx) => this.store.find(tx, id));
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return reviewViewOf(row);
  }
}
