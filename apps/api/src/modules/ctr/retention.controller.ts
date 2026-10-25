import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { BidContractorStore, CtrRetentionStore, TenantDatabase, contractScope } from '@machvon/db';
import type { ContractScopes, CtrHoldLine, CtrReleaseRetentionResult } from '@machvon/db';
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
import { placeRefs, reaches } from './contract.controller';

const RELEASE_PERMISSION = PERMISSIONS.releaseRetention;
const READ_PERMISSION = PERMISSIONS.listRetentionHolds;
const RESOURCE_TYPE = 'retention_hold';
const CLASSIFICATION = 'INTERNAL';

const scopesFor = (access: EffectiveAccess, now: Date): ContractScopes => ({ update: contractScope(access, RELEASE_PERMISSION, now), read: contractScope(access, READ_PERMISSION, now) });

/**
 * The release of the retention held back from a payment (ST-CTR-010, CTR 3.5, BR-CTR-09). The chief accountant, who holds `retention.release` over the contract, releases a hold when its condition
 * is met (422 `RELEASE_CONDITION_NOT_MET`), up to what is still held (422 `RELEASE_EXCEEDS_HELD`) and not for money held in their own name (403 `SELF_APPROVAL_DENIED`). The release goes on the
 * ledger and on the totals of the contract in the same transaction and is announced (`ctr.retention.released.v1`) for PAY, which pays it by a payment request of its own.
 */
@Controller()
export class RetentionController {
  private readonly retention = new CtrRetentionStore();

  @Post('retention-holds/:id/release')
  @HttpCode(200)
  @OperationId('releaseRetention')
  @Command({ operation: 'releaseRetention', versioned: true })
  async release(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['CtrReleaseRetention']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.retention.release(
      scope.tx,
      id.toLowerCase(),
      scope.expectedVersion ?? 0,
      { amountVnd: body.amount_vnd, reason: body.reason, decisionDocumentVersionId: body.decision_document_version_id },
      scope.tenant.membershipId,
      scope.requestId,
      scopesFor(access, now),
      now,
    );
    await this.written(scope, done, now);
    return commandResult(scope, done.status, done.version, done.id);
  }

  /** The audit row and the event of a release: ids, the condition, the amounts and the totals of the contract; the reason is the person's words and stays in the hold. */
  private async written(scope: CommandScope, done: CtrReleaseRetentionResult, now: Date): Promise<void> {
    const facts = {
      contract_id: done.contractId,
      contract_code: done.contractCode,
      project_id: done.projectId,
      boq_item_id: done.boqItemId,
      payment_request_id: done.paymentRequestId,
      release_condition: done.releaseCondition,
      held_vnd: done.heldVnd,
      amount_vnd: done.amountVnd,
      released_vnd: done.releasedVnd,
      decision_document_version_id: done.decisionDocumentVersionId,
      contract_retention_held_vnd: done.contractRetentionHeldVnd,
      contract_retention_released_vnd: done.contractRetentionReleasedVnd,
    };
    await scope.audit({
      action: 'retention.released',
      resourceType: RESOURCE_TYPE,
      resourceId: done.id,
      classification: CLASSIFICATION,
      diff: { from_status: done.fromStatus, to_status: done.status, ...facts },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: done.id,
      aggregateVersion: done.version,
      type: 'ctr.retention.released.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        hold_id: done.id,
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

/** A hold as openapi.json exposes it (x-exposure dto): an allowlist, with whether the money may be released today and, if not, why. */
function holdView(line: CtrHoldLine, allowed: boolean): Record<string, unknown> {
  return {
    id: line.id,
    boq_item: { id: line.boqItem.id, key: line.boqItem.key, description: line.boqItem.description },
    party_id: line.partyId,
    payment_request_id: line.paymentRequestId,
    acceptance_id: line.acceptanceId,
    held_vnd: line.heldVnd,
    released_vnd: line.releasedVnd,
    left_vnd: line.leftVnd,
    release_condition: line.releaseCondition,
    release_not_before: line.releaseNotBefore,
    status: line.status,
    condition: { met: line.blocker === null, reason: line.blocker },
    released_at: line.releasedAt,
    release_reason: line.releaseReason,
    decision_document_version_id: line.decisionDocumentVersionId,
    created_at: line.createdAt,
    allowed: { release: allowed && (line.status === 'HELD' || line.status === 'PARTIALLY_RELEASED') && line.leftVnd !== '0' },
    version: line.version,
  };
}

/**
 * The holds of retention of a contract (CTR-21): for the staff who hold `ledger.read` over the contract, never for a contractor of the contract (403 `SCOPE_DENIED`), and 404 for a contract
 * outside the scope of the caller.
 */
@Controller('contracts/:id/retention-holds')
export class RetentionReadsController {
  private readonly retention = new CtrRetentionStore();
  private readonly contractors = new BidContractorStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  @OperationId('listRetentionHolds')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('status') status?: unknown,
    @Query('cursor') cursor?: unknown,
    @Query('limit') limit?: unknown,
  ): Promise<{ contract: Record<string, unknown>; items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    if (status !== undefined && typeof status !== 'string') throw new DomainError('VALIDATION_FAILED', 422, 'status');
    const request = parsePageRequest(limit, cursor);
    const now = new Date();
    const contractId = id.toLowerCase();
    const scope = contractScope(access, READ_PERMISSION, now);
    const read = await this.database.withTenant(tenant, async (tx) => {
      const header = await this.retention.header(tx, contractId, scope);
      if (header === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      // The contractor of the contract sees its own contract elsewhere, never what the owner holds back from it.
      if ((await this.contractors.callerOf(tx, tenant.membershipId)).guest) throw new DomainError('SCOPE_DENIED', 403);
      const rows = await this.retention.list(tx, contractId, scope, { status, limit: request.limit + 1, after: request.after }, now);
      return { header, rows };
    });
    const shown = read.rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    const mayRelease = reaches(access, RELEASE_PERMISSION, placeRefs(read.header.place), now);
    return {
      contract: {
        id: read.header.contractId,
        code: read.header.contractCode,
        status: read.header.contractStatus,
        retention_held_vnd: read.header.retentionHeldVnd,
        retention_released_vnd: read.header.retentionReleasedVnd,
      },
      items: shown.map((line) => holdView(line, mayRelease)),
      next_cursor: read.rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.createdAt, id: last.id }) : null,
      as_of: now.toISOString(),
    };
  }
}
