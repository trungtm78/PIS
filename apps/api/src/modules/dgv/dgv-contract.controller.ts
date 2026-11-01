import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { CONSUMER_APPROVAL_RESOURCE, CONTRACT_RESOURCE, DgvContractStore, TenantDatabase } from '@machvon/db';
import type { DgvConsumerApproval, DgvContractDetail, DgvContractRevision, DgvContractVersion } from '@machvon/db';
import { DomainError, canonicalJson, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { randomUUID } from 'node:crypto';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { FileService } from '../files';
import { assertTenantAuthority, pageSize, textOf, uuidOf, viewerOf } from './inputs';

/** The kind of the object key the documents of the published contracts are stored under. */
export const CONTRACT_DOCUMENT_KIND = 'dgv_contract';
const DRAFTED_EVENT = 'dgv.contract.drafted.v1';
const DECIDED_EVENT = 'dgv.contract.consumer_decided.v1';
const PUBLISHED_EVENT = 'dgv.contract.published.v1';

export function approvalView(approval: DgvConsumerApproval): Record<string, unknown> {
  return {
    id: approval.id,
    consumer_kind: approval.consumerKind,
    consumer_ref: approval.consumerRef,
    consumer_owner: { membership_id: approval.consumerOwnerId, display_name: approval.consumerOwnerName },
    decision: approval.decision,
    decided_by: approval.decidedBy,
    decided_at: approval.decidedAt,
    comment: approval.comment,
    version: approval.version,
  };
}

/** The revision as the contract exposes it: an allowlist. */
export function revisionView(revision: DgvContractRevision): Record<string, unknown> {
  return {
    id: revision.id,
    dataset_id: revision.datasetId,
    dataset_code: revision.datasetCode,
    revision: revision.revision,
    status: revision.status,
    odcs_version: revision.odcsVersion,
    compatibility: revision.compatibility,
    effective_from: revision.effectiveFrom,
    freshness_seconds: revision.freshnessSeconds,
    classification: revision.classification,
    owner_id: revision.ownerId,
    created_by: revision.createdBy,
    approved_by: revision.approvedBy,
    created_at: revision.createdAt,
    columns: revision.columns,
    consumer_approvals: revision.approvals.map(approvalView),
    version: revision.version,
  };
}

const detailView = (detail: DgvContractDetail): Record<string, unknown> => ({ ...revisionView(detail), odcs_json: detail.odcs, changes: detail.changes });

export function versionView(version: DgvContractVersion): Record<string, unknown> {
  return {
    id: version.id,
    dataset_id: version.datasetId,
    dataset_code: version.datasetCode,
    contract_id: version.contractId,
    revision: version.revision,
    grain: version.grain,
    owner_id: version.ownerId,
    compatibility: version.compatibility,
    odcs_sha256: version.odcsSha256,
    odcs_object_key: version.odcsObjectKey,
    published_by: version.publishedBy,
    published_at: version.publishedAt,
    supersedes_id: version.supersedesId,
    migration_window_until: version.migrationWindowUntil,
    serving: version.serving,
    serving_until: version.servingUntil,
    columns: version.columns,
  };
}

/** The page size of a read: 50 when it is not given, 1 to 200, anything else is 422 naming the parameter. */
/**
 * The data contracts (ST-DGV-005, DGV 3.1 F2, DGV-13, DGV-19, UAT-AC50). A steward drafts the next revision of the contract of a dataset from an ODCS document of the pinned version; the platform works out its compatibility
 * with the published version; a breaking revision is approved, consumer by consumer, by the owner of each; somebody other than the person who drafted it publishes it, with a window in which the version before it still
 * serves; the published version is written once, with the hash of its document.
 */
@Controller()
export class DgvContractCommandsController {
  private readonly contracts = new DgvContractStore();

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Inject(FileService) private readonly files: FileService,
  ) {}

  @Post('dgv/dataset-contracts')
  @HttpCode(200)
  @OperationId('createDatasetContractRevision')
  @Command({ operation: 'createDatasetContractRevision' })
  async draft(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['DgvContractDraft']): Promise<CommandResult & Record<string, unknown>> {
    assertTenantAuthority(access, PERMISSIONS.createDatasetContractRevision);
    const made = await this.contracts.draft(
      scope.tx,
      { datasetId: uuidOf(body.dataset_id, 'dataset_id'), odcsVersion: body.odcs_version, odcs: body.odcs_json, effectiveFrom: body.effective_from },
      scope.tenant.membershipId,
      viewerOf(scope.tenant, access),
    );
    await scope.audit({
      action: 'dgv.contract_drafted',
      resourceType: CONTRACT_RESOURCE,
      resourceId: made.id,
      classification: 'INTERNAL',
      diff: {
        dataset_id: made.datasetId,
        revision: made.revision,
        compatibility: made.compatibility,
        odcs_version: made.odcsVersion,
        effective_from: made.effectiveFrom,
        consumers: made.approvals.map((approval) => `${approval.consumerKind}:${approval.consumerRef}`),
      },
    });
    await scope.emit({
      aggregateType: CONTRACT_RESOURCE,
      aggregateId: made.id,
      aggregateVersion: made.version,
      type: DRAFTED_EVENT,
      schemaVersion: 1,
      payload: { contract_id: made.id, dataset_id: made.datasetId, revision: made.revision, compatibility: made.compatibility, consumer_count: made.approvals.length },
      eventKey: `${CONTRACT_RESOURCE}:${made.id}:drafted`,
    });
    return { ...commandResult(scope, made.status, made.version, made.id), revision: made.revision, compatibility: made.compatibility, consumer_approvals: made.approvals.map(approvalView) };
  }

  @Post('dgv/contract-consumer-approvals/:id/decision')
  @HttpCode(200)
  @OperationId('recordConsumerApproval')
  @Command({ operation: 'recordConsumerApproval', versioned: true })
  async decide(@Scope() scope: CommandScope, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['DgvConsumerDecision']): Promise<CommandResult> {
    const done = await this.contracts.decideConsumer(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, { decision: body.decision, comment: body.comment }, scope.tenant.membershipId);
    await scope.audit({
      action: 'dgv.contract_consumer_decided',
      resourceType: CONSUMER_APPROVAL_RESOURCE,
      resourceId: done.approval.id,
      classification: 'INTERNAL',
      diff: {
        contract_id: done.contract.id,
        dataset_id: done.contract.datasetId,
        revision: done.contract.revision,
        consumer: `${done.approval.consumerKind}:${done.approval.consumerRef}`,
        from: done.previous,
        to: done.approval.decision,
      },
    });
    await scope.emit({
      aggregateType: CONSUMER_APPROVAL_RESOURCE,
      aggregateId: done.approval.id,
      aggregateVersion: done.approval.version,
      type: DECIDED_EVENT,
      schemaVersion: 1,
      payload: {
        contract_id: done.contract.id,
        dataset_id: done.contract.datasetId,
        revision: done.contract.revision,
        consumer_kind: done.approval.consumerKind,
        consumer_ref: done.approval.consumerRef,
        decision: done.approval.decision,
      },
      eventKey: `${CONSUMER_APPROVAL_RESOURCE}:${done.approval.id}:${done.approval.version}`,
    });
    return commandResult(scope, done.approval.decision, done.approval.version, done.approval.id);
  }

  /** The approvals that are addressed to the caller as the owner of a consumer, with the revision each is about: the way they are asked, whether or not they may see the dataset. */
  @Get('dgv/contract-consumer-approvals')
  @OperationId('listConsumerApprovals')
  async approvals(
    @CurrentTenant() tenant: TenantContext,
    @Query('decision') decision?: unknown,
    @Query('cursor') cursor?: unknown,
    @Query('limit') limit?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null }> {
    const size = pageSize(limit);
    const page = await this.database.withTenant(tenant, (tx) =>
      this.contracts.approvalsFor(tx, tenant.membershipId, { decision: textOf(decision, 'decision'), cursor: textOf(cursor, 'cursor'), limit: size }),
    );
    return {
      items: page.items.map(({ approval, contract }) => ({
        ...approvalView(approval),
        contract: {
          id: contract.id,
          dataset_id: contract.datasetId,
          dataset_code: contract.datasetCode,
          revision: contract.revision,
          status: contract.status,
          compatibility: contract.compatibility,
          effective_from: contract.effectiveFrom,
          odcs_version: contract.odcsVersion,
          changes: contract.changes,
        },
      })),
      next_cursor: page.next,
    };
  }

  @Post('dgv/dataset-contracts/:id/publish')
  @HttpCode(200)
  @OperationId('publishDatasetContract')
  @Command({ operation: 'publishDatasetContract', versioned: true })
  async publish(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['DgvContractPublish'],
  ): Promise<CommandResult & Record<string, unknown>> {
    assertTenantAuthority(access, PERMISSIONS.publishDatasetContract);
    return this.publishRevision(scope, access, id.toLowerCase(), body.migration_window_until, undefined);
  }

  /** The baseline decision on a revision in review: approve publishes it (a breaking one needs the window the other command takes), return and reject close it so that another can be drafted. */
  @Post('data-contracts/:id/publish')
  @HttpCode(200)
  @OperationId('post_data_contracts_id_publish')
  @Command({ operation: 'post_data_contracts_id_publish', versioned: true })
  async decideRevision(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['Decision'],
  ): Promise<CommandResult & Record<string, unknown>> {
    assertTenantAuthority(access, PERMISSIONS.post_data_contracts_id_publish);
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (reason === '' || reason.length > 2000 || reason.includes('\0')) throw new DomainError('VALIDATION_FAILED', 422, 'reason');
    const evidence = body.evidence_ids.map((evidenceId) => uuidOf(evidenceId, 'evidence_ids'));
    if (body.decision === 'approve') return this.publishRevision(scope, access, id.toLowerCase(), undefined, { reason, evidence });
    if (body.decision !== 'return' && body.decision !== 'reject') throw new DomainError('VALIDATION_FAILED', 422, 'decision');
    const closed = await this.contracts.close(
      scope.tx,
      id.toLowerCase(),
      scope.expectedVersion ?? 0,
      body.decision === 'return' ? 'RETURNED' : 'REJECTED',
      scope.tenant.membershipId,
      viewerOf(scope.tenant, access),
    );
    await scope.audit({
      action: body.decision === 'return' ? 'dgv.contract_returned' : 'dgv.contract_rejected',
      resourceType: CONTRACT_RESOURCE,
      resourceId: closed.id,
      classification: 'INTERNAL',
      reason,
      diff: { dataset_id: closed.datasetId, revision: closed.revision, status: closed.status, evidence_ids: evidence },
    });
    return { ...commandResult(scope, closed.status, closed.version, closed.id), revision: closed.revision };
  }

  private async publishRevision(
    scope: CommandScope,
    access: EffectiveAccess,
    id: string,
    windowUntil: string | undefined,
    decision: { reason: string; evidence: string[] } | undefined,
  ): Promise<CommandResult & Record<string, unknown>> {
    const viewer = viewerOf(scope.tenant, access);
    const versionId = randomUUID();
    const outcome = await this.contracts.publish(
      scope.tx,
      id,
      scope.expectedVersion ?? 0,
      {
        migrationWindowUntil: windowUntil,
        versionId,
        // The document of the revision is stored as the version is made, and taken back if the command does not commit (a publication that is refused leaves no file behind).
        storeDocument: async (odcs) => {
          const key = await this.files.storeGenerated(scope.tenant, CONTRACT_DOCUMENT_KIND, versionId, Buffer.from(canonicalJson(odcs), 'utf8'), 'application/json');
          scope.afterRollback(async () => {
            await this.files.remove(scope.tenant, key).catch(() => false);
          });
          return key;
        },
        today: vietnamDateOf(new Date()),
      },
      scope.tenant.membershipId,
      viewer,
    );
    if (outcome.kind === 'CONSUMERS_ADDED') {
      // The owners of the consumers that became known since the revision was drafted are asked now; that is kept, and the answer to this publication is that they have not approved.
      await scope.audit({
        action: 'dgv.contract_consumers_added',
        resourceType: CONTRACT_RESOURCE,
        resourceId: outcome.contract.id,
        classification: 'INTERNAL',
        diff: { dataset_id: outcome.contract.datasetId, revision: outcome.contract.revision, waiting: outcome.waiting.map((item) => `${item.kind}:${item.ref}:${item.decision}`) },
      });
      scope.refuseAfterCommit(new DomainError('CONSUMER_APPROVAL_PENDING', 409, 'consumers', { extensions: { consumers: outcome.waiting } }));
      return { ...commandResult(scope, outcome.contract.status, outcome.contract.version, outcome.contract.id), consumers: outcome.waiting };
    }
    const done = outcome;
    await scope.audit({
      action: 'dgv.contract_published',
      resourceType: CONTRACT_RESOURCE,
      resourceId: done.contract.id,
      classification: 'INTERNAL',
      ...(decision === undefined ? {} : { reason: decision.reason }),
      diff: {
        dataset_id: done.contract.datasetId,
        revision: done.contract.revision,
        compatibility: done.contract.compatibility,
        odcs_sha256: done.sha256,
        data_contract_version_id: done.version.id,
        supersedes_id: done.supersededId,
        migration_window_until: done.version.migrationWindowUntil,
        ...(decision === undefined ? {} : { evidence_ids: decision.evidence }),
      },
    });
    await scope.emit({
      aggregateType: CONTRACT_RESOURCE,
      aggregateId: done.contract.id,
      aggregateVersion: done.contract.version,
      type: PUBLISHED_EVENT,
      schemaVersion: 1,
      payload: {
        contract_id: done.contract.id,
        dataset_id: done.contract.datasetId,
        revision: done.contract.revision,
        compatibility: done.contract.compatibility,
        odcs_sha256: done.sha256,
        migration_window_until: done.version.migrationWindowUntil,
      },
      eventKey: `${CONTRACT_RESOURCE}:${done.contract.id}:published`,
    });
    return {
      ...commandResult(scope, done.contract.status, done.contract.version, done.contract.id),
      revision: done.contract.revision,
      compatibility: done.contract.compatibility,
      data_contract_version_id: done.version.id,
      odcs_sha256: done.sha256,
      migration_window_until: done.version.migrationWindowUntil,
    };
  }
}

/** The revisions of the contracts, with the document and the changes from the version before it in the one that is asked for. A revision of a dataset the reader may not see is not in the list and is as unknown as an id of another tenant. */
@Controller()
export class DatasetContractReadsController {
  private readonly contracts = new DgvContractStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('resources/dataset_contract')
  @OperationId('get_resources_dataset_contract')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('dataset_id') datasetId?: unknown,
    @Query('status') status?: unknown,
    @Query('cursor') cursor?: unknown,
    @Query('limit') limit?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null }> {
    const size = pageSize(limit);
    const page = await this.database.withTenant(tenant, (tx) =>
      this.contracts.list(tx, viewerOf(tenant, access), {
        datasetId: datasetId === undefined ? undefined : uuidOf(datasetId, 'dataset_id'),
        status: textOf(status, 'status'),
        cursor: textOf(cursor, 'cursor'),
        limit: size,
      }),
    );
    return { items: page.items.map(revisionView), next_cursor: page.next };
  }

  @Get('resources/dataset_contract/:id')
  @OperationId('get_resources_dataset_contract_id')
  async one(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const found = await this.database.withTenant(tenant, (tx) => this.contracts.find(tx, id.toLowerCase(), viewerOf(tenant, access)));
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return detailView(found);
  }
}

/** The published versions: written once, each with the hash of its document, and whether it serves now (the version the dataset stands on, or the one before it while the window of a breaking change lasts). */
@Controller()
export class DataContractVersionReadsController {
  private readonly contracts = new DgvContractStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('resources/data_contract_version')
  @OperationId('get_resources_data_contract_version')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('dataset_id') datasetId?: unknown,
    @Query('cursor') cursor?: unknown,
    @Query('limit') limit?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null }> {
    const size = pageSize(limit);
    const page = await this.database.withTenant(tenant, (tx) =>
      this.contracts.listVersions(
        tx,
        viewerOf(tenant, access),
        { datasetId: datasetId === undefined ? undefined : uuidOf(datasetId, 'dataset_id'), cursor: textOf(cursor, 'cursor'), limit: size },
        vietnamDateOf(new Date()),
      ),
    );
    return { items: page.items.map(versionView), next_cursor: page.next };
  }

  @Get('resources/data_contract_version/:id')
  @OperationId('get_resources_data_contract_version_id')
  async one(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const found = await this.database.withTenant(tenant, (tx) => this.contracts.findVersion(tx, id.toLowerCase(), viewerOf(tenant, access), vietnamDateOf(new Date())));
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return versionView(found);
  }
}
