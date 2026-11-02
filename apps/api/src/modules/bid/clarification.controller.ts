import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { BidClarificationStore, BidContractorStore, TenantDatabase, projectScope } from '@machvon/db';
import type { BidClarificationLine, BidClarificationResult, BidClarificationViewer } from '@machvon/db';
import { DomainError, asUuid, clarificationStatusAt, effectivePermissions, holdsPermission } from '@machvon/kernel';
import type { EffectiveAccess, ResourceRef, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';

const RESOURCE_TYPE = 'bid_clarification';
const CLASSIFICATION = 'CONFIDENTIAL';
const SEND_PERMISSION = PERMISSIONS.sendBidClarification;
const ANSWER_PERMISSION = PERMISSIONS.recordClarificationAnswer;
const READ_PERMISSION = PERMISSIONS.listBidClarifications;

const idOf = (value: unknown, field: string): string => {
  const id = typeof value === 'string' ? asUuid(value) : undefined;
  if (id === undefined) throw new DomainError('VALIDATION_FAILED', 422, field);
  return id.toLowerCase();
};

const person = (who: { membershipId: string; displayName: string } | null): Record<string, unknown> | null => (who === null ? null : { membership_id: who.membershipId, display_name: who.displayName });

/** The places the package lies in for the permission test: the units that own and invest in its project. */
const refsOf = (line: BidClarificationLine): ResourceRef[] =>
  [line.reach.ownerUnit, ...(line.reach.investorUnit === null ? [] : [line.reach.investorUnit])].map((unit) => ({ ownerUnitPath: unit.path, ownerUnitId: unit.id, projectId: line.project.id }));

/**
 * A request as BID-11 reads it: an allowlist of what it is. A contractor sees what asks them and what they answered, never who on the evaluation team asked or which finding of the analysis the question rests on.
 * The caller may answer while the request waits and its deadline has not passed, when they hold the permission (a guest by the contractor they are a guest of, the staff over the project); the server judges the command again.
 */
export function clarificationDto(line: BidClarificationLine, access: EffectiveAccess, guest: boolean, now: Date): Record<string, unknown> {
  const status = clarificationStatusAt(line.status, line.dueAt, now);
  const permitted = guest ? holdsPermission(effectivePermissions(access, now), ANSWER_PERMISSION) : refsOf(line).some((ref) => holdsPermission(effectivePermissions(access, now, ref), ANSWER_PERMISSION));
  return {
    id: line.id,
    package: { id: line.package.id, code: line.package.code },
    project_id: line.project.id,
    proposal_id: line.proposalId,
    contractor: { id: line.contractor.id, legal_name: line.contractor.legalName },
    question: line.question,
    basis_finding: guest || line.basisFinding === null ? null : { id: line.basisFinding.id, criterion_code: line.basisFinding.criterionCode },
    due_at: line.dueAt,
    status,
    sent_document_id: line.sentDocumentId,
    answer_document_id: line.answerDocumentId,
    answered_at: line.answeredAt,
    answered_by: person(line.answeredBy),
    answered_as_guest: line.answeredAsGuest,
    asked_by: guest ? null : person(line.askedBy),
    created_at: line.createdAt,
    actions: { answer: status === 'SENT' && permitted },
    version: line.version,
  };
}

/**
 * The clarification requests to contractors during the evaluation of bids (ST-BID-011, BID 3 F6, BR-BID-03, BID-11). A member of the evaluation team who has the full view of a proposal asks its contractor to explain
 * something in it, with a deadline; the question is carried by a letter, a confidential document of DOC about the request. The contractor answers as a guest of their own contractor, or the clerk who took their letter
 * records it, with a document, before the deadline: the second answer, or one that comes late, is refused and the request is not changed. A contractor sees only the requests that ask them; another contractor's, another
 * tenant's, or one a conflict of interest shuts a member out of does not exist for the caller.
 */
@Controller()
export class ClarificationController {
  private readonly store = new BidClarificationStore();
  private readonly contractors = new BidContractorStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Post('bid-clarifications')
  @HttpCode(200)
  @OperationId('sendBidClarification')
  @Command({ operation: 'sendBidClarification' })
  async send(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['BidClarificationCreate']): Promise<CommandResult> {
    const now = new Date();
    // The evaluation team asks; a guest contractor never does, whatever they hold.
    if ((await this.contractors.callerOf(scope.tx, scope.tenant.membershipId)).guest) throw new DomainError('SCOPE_DENIED', 403);
    const sent = await this.store.send(
      scope.tx,
      { proposalId: body.proposal_id, question: body.question, basisFindingId: body.basis_finding_id, dueAt: body.due_at },
      { membershipId: scope.tenant.membershipId, evaluate: projectScope(access, SEND_PERMISSION, now) },
      scope.tenant.membershipId,
      now,
    );
    await this.written(scope, sent, 'bid.clarification_sent', 'bid.clarification.sent.v1', now);
    return commandResult(scope, sent.status, sent.version, sent.id);
  }

  @Post('bid-clarifications/:id/answer')
  @HttpCode(200)
  @OperationId('recordClarificationAnswer')
  @Command({ operation: 'recordClarificationAnswer', versioned: true })
  async answer(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['BidClarificationAnswer']): Promise<CommandResult> {
    const now = new Date();
    const viewer = await this.viewerOf(scope.tx, scope.tenant, access, ANSWER_PERMISSION, now);
    const done = await this.store.answer(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, { answerDocumentId: body.answer_document_id }, viewer, now);
    await this.written(scope, done, 'bid.clarification_answered', 'bid.clarification.answered.v1', now);
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Get('bid-clarifications')
  @OperationId('listBidClarifications')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('package_id') packageId?: unknown,
    @Query('proposal_id') proposalId?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; as_of: string }> {
    const filter = {
      packageId: packageId === undefined ? undefined : idOf(packageId, 'package_id'),
      proposalId: proposalId === undefined ? undefined : idOf(proposalId, 'proposal_id'),
    };
    const now = new Date();
    const read = await this.database.withTenant(tenant, async (tx) => {
      const viewer = await this.viewerOf(tx, tenant, access, READ_PERMISSION, now);
      return { ...(await this.store.list(tx, viewer, filter)), guest: viewer.guestContractorId !== null };
    });
    if (read.owed) throw new DomainError('CONFLICT_UNDECLARED', 403);
    return { items: read.lines.map((line) => clarificationDto(line, access, read.guest, now)), as_of: now.toISOString() };
  }

  @Get('bid-clarifications/:id')
  @OperationId('getBidClarification')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = new Date();
    const read = await this.database.withTenant(tenant, async (tx) => {
      const viewer = await this.viewerOf(tx, tenant, access, READ_PERMISSION, now);
      return { found: await this.store.find(tx, id.toLowerCase(), viewer), guest: viewer.guestContractorId !== null };
    });
    if (read.found.kind === 'DECLARATION_REQUIRED') throw new DomainError('CONFLICT_UNDECLARED', 403);
    if (read.found.kind === 'HIDDEN') throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return clarificationDto(read.found.line, access, read.guest, now);
  }

  /** Who the caller is for the requests: a guest of one contractor, or staff over the projects of the permission of the operation. */
  private async viewerOf(tx: CommandScope['tx'], tenant: TenantContext, access: EffectiveAccess, permission: string, now: Date): Promise<BidClarificationViewer> {
    const caller = await this.contractors.callerOf(tx, tenant.membershipId);
    return {
      membershipId: tenant.membershipId,
      guestContractorId: caller.guest ? caller.contractorId : null,
      reach: projectScope(access, permission, now),
      evaluate: projectScope(access, SEND_PERMISSION, now),
    };
  }

  /** The audit row and the event of a command: ids, codes, dates and statuses, never the words of the question or of the contractor. */
  private async written(scope: CommandScope, done: BidClarificationResult, action: string, type: string, now: Date): Promise<void> {
    const facts = {
      package_id: done.packageId,
      package_code: done.packageCode,
      project_id: done.projectId,
      proposal_id: done.proposalId,
      contractor_id: done.contractorId,
      basis_finding_id: done.basisFindingId,
      due_at: done.dueAt,
      sent_document_id: done.sentDocumentId,
      answer_document_id: done.answerDocumentId,
    };
    await scope.audit({
      action,
      resourceType: RESOURCE_TYPE,
      resourceId: done.id,
      classification: CLASSIFICATION,
      diff: { from_status: done.fromStatus, to_status: done.status, ...facts, ...(done.answeredAsGuest === null ? {} : { answered_as_guest: done.answeredAsGuest }) },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: done.id,
      aggregateVersion: done.version,
      type,
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        clarification_id: done.id,
        ...facts,
        status: done.status,
        from_status: done.fromStatus,
        answered_at: done.answeredAt,
        answered_as_guest: done.answeredAsGuest,
        version: done.version,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
      },
      eventKey: `${RESOURCE_TYPE}:${done.id}:${done.version}`,
    });
  }
}
