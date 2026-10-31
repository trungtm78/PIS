import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { AstClaimStore, TenantDatabase, guestContractorOf, handoverScope } from '@machvon/db';
import type { AstClaimResult, HandoverScopes } from '@machvon/db';
import { DomainError, asUuid, vietnamDateOf } from '@machvon/kernel';
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
import { claimView } from './claim-view';
import type { ClaimPermissions } from './claim-view';

const CLAIM_PERMISSION = PERMISSIONS.fileWarrantyClaim;
const RESPOND_PERMISSION = PERMISSIONS.acknowledgeWarrantyClaim;
const VERIFY_PERMISSION = PERMISSIONS.verifyWarrantyClaim;
const READ_PERMISSION = PERMISSIONS.listWarrantyObligations;
const RESOURCE_TYPE = 'warranty_claim';
const CLASSIFICATION = 'INTERNAL';

const ACTION_PERMISSIONS: ClaimPermissions = { claim: CLAIM_PERMISSION, respond: RESPOND_PERMISSION, verify: VERIFY_PERMISSION };

const scopesFor = (access: EffectiveAccess, permission: string, now: Date): HandoverScopes => ({ update: handoverScope(access, permission, now), read: handoverScope(access, READ_PERMISSION, now) });

/**
 * The claims against a warranty and the answer to them (ST-AST-004, AST 3.3, BR-AST-03, UAT-AC390, UAT-AC391). The owner files a claim on an obligation that has not run out (422 `WARRANTY_EXPIRED`) against a
 * contractor of the contract; the contractor acknowledges it with the day it commits to and says it is put right with evidence (422 `EVIDENCE_REQUIRED`); somebody who neither reported the defect nor said it was put
 * right verifies the repair or disputes it (403 `SELF_APPROVAL_DENIED`). A claim nobody answers by its day is flagged by a job and ISS is asked for an issue.
 */
@Controller()
export class ClaimController {
  private readonly claims = new AstClaimStore();

  @Post('warranty-obligations/:id/claims')
  @HttpCode(200)
  @OperationId('fileWarrantyClaim')
  @Command({ operation: 'fileWarrantyClaim' })
  async file(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['AstFileWarrantyClaim']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.claims.file(
      scope.tx,
      {
        obligationId: id.toLowerCase(),
        claimNo: body.claim_no,
        reportedOn: body.reported_on,
        defectDescription: body.defect_description,
        severity: body.severity,
        locationText: body.location_text,
        evidencePhotoId: body.evidence_photo_id,
        evidenceDocumentVersionId: body.evidence_document_version_id,
        responderContractorId: body.responder_contractor_id,
      },
      scope.tenant.membershipId,
      scopesFor(access, CLAIM_PERMISSION, now),
    );
    await this.written(scope, done, 'warranty_claim.filed', 'ast.warranty_claim.filed.v1', now);
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('warranty-claims/:id/acknowledge')
  @HttpCode(200)
  @OperationId('acknowledgeWarrantyClaim')
  @Command({ operation: 'acknowledgeWarrantyClaim', versioned: true })
  async acknowledge(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['AstAcknowledgeWarrantyClaim'],
  ): Promise<CommandResult> {
    const now = new Date();
    const done = await this.claims.acknowledge(
      scope.tx,
      id.toLowerCase(),
      scope.expectedVersion ?? 0,
      { committedFixOn: body.committed_fix_on, note: body.note },
      scope.tenant.membershipId,
      scopesFor(access, RESPOND_PERMISSION, now),
      now,
    );
    await this.written(scope, done, 'warranty_claim.acknowledged', 'ast.warranty_claim.acknowledged.v1', now);
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('warranty-claims/:id/fixed')
  @HttpCode(200)
  @OperationId('recordWarrantyFix')
  @Command({ operation: 'recordWarrantyFix', versioned: true })
  async fixed(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['AstRecordWarrantyFix']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.claims.fix(
      scope.tx,
      id.toLowerCase(),
      scope.expectedVersion ?? 0,
      { fixedOn: body.fixed_on, evidencePhotoId: body.evidence_photo_id, evidenceDocumentVersionId: body.evidence_document_version_id, note: body.note },
      scope.tenant.membershipId,
      scopesFor(access, RESPOND_PERMISSION, now),
    );
    await this.written(scope, done, 'warranty_claim.fixed', 'ast.warranty_claim.fixed.v1', now);
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('warranty-claims/:id/verify')
  @HttpCode(200)
  @OperationId('verifyWarrantyClaim')
  @Command({ operation: 'verifyWarrantyClaim', versioned: true })
  async verify(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['AstVerifyWarrantyClaim']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.claims.verify(
      scope.tx,
      id.toLowerCase(),
      scope.expectedVersion ?? 0,
      { outcome: body.outcome, costBorneBy: body.cost_borne_by, note: body.note },
      scope.tenant.membershipId,
      scopesFor(access, VERIFY_PERMISSION, now),
      now,
    );
    await this.written(scope, done, 'warranty_claim.verified', 'ast.warranty_claim.verified.v1', now);
    return commandResult(scope, done.status, done.version, done.id);
  }

  /** The audit row and the event of a command: ids, the claim number, the severity and the days; the words of the defect and of the answers stay in the table. */
  private async written(scope: CommandScope, done: AstClaimResult, action: string, type: string, now: Date): Promise<void> {
    const facts = {
      obligation_id: done.obligationId,
      claim_no: done.claimNo,
      contract_id: done.contractId,
      contract_code: done.contractCode,
      handover_id: done.handoverId,
      project_id: done.projectId,
      severity: done.severity,
      responder_contractor_id: done.responderContractorId,
      reported_on: done.reportedOn,
      response_due_on: done.responseDueOn,
      committed_fix_on: done.committedFixOn,
      fixed_on: done.fixedOn,
      cost_borne_by: done.costBorneBy,
    };
    await scope.audit({ action, resourceType: RESOURCE_TYPE, resourceId: done.id, classification: CLASSIFICATION, diff: { from_status: done.fromStatus, to_status: done.status, ...facts } });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: done.id,
      aggregateVersion: done.version,
      type,
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        claim_id: done.id,
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

/** The claims in the scope of the caller (the right to read them is `warranty.read`). */
@Controller('warranty-claims')
export class ClaimReadsController {
  private readonly claims = new AstClaimStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  @OperationId('listWarrantyClaims')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
    @Query('obligation_id') obligationId?: unknown,
    @Query('status') status?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const request = parsePageRequest(limit, cursor);
    if (status !== undefined && typeof status !== 'string') throw new DomainError('VALIDATION_FAILED', 422, 'status');
    const obligation = obligationId === undefined ? undefined : typeof obligationId === 'string' ? asUuid(obligationId) : undefined;
    if (obligationId !== undefined && obligation === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'obligation_id');
    const now = new Date();
    const { rows, guestContractorId } = await this.database.withTenant(tenant, async (tx) => ({
      rows: await this.claims.list(tx, handoverScope(access, READ_PERMISSION, now), { obligationId: obligation?.toLowerCase(), status, today: vietnamDateOf(now), limit: request.limit + 1, after: request.after }),
      guestContractorId: await guestContractorOf(tx, tenant.membershipId),
    }));
    const caller = { memberId: tenant.membershipId, guestContractorId };
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map((line) => claimView(line, access, caller, now, ACTION_PERMISSIONS)),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.createdAt, id: last.id }) : null,
      as_of: now.toISOString(),
    };
  }
}
