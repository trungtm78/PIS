import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { AuditWriter, TenantDatabase, enqueueOutbox } from '@machvon/db';
import type { IssueRequestRecord, TenantTx } from '@machvon/db';
import { DomainError } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { holdsOnWholeTenant } from '../adm/tenant-authority';
import { DocumentReferencePort } from './document-reference-port';
import { DocumentIssueService, normaliseIssueRequest } from './issue-request.service';
import type { IssueContext, IssueRequestInput, Rejection } from './issue-request.service';

function requestView(request: IssueRequestRecord): Record<string, unknown> {
  return { issue_request_id: request.id, issue_status: request.status, outgoing_document_id: request.outgoingDocumentId, template_id: request.templateId };
}

/**
 * The two ports of DOC that source modules use over HTTP (ST-DOC-008, DOC.md F2 and section 7). A source module asks for a document with a payload it wrote
 * and the SHA-256 of it; DOC checks both and answers with a draft or with the reason (and keeps the refusal, because the module reads `doc.rejected.v1`).
 * The reference check says whether a document may be relied on. Neither lets a module mark a document issued: only DOC does, after the signatures.
 */
@Controller()
export class IssueRequestsController {
  private readonly reference = new DocumentReferencePort();
  private readonly audit: AuditWriter;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Inject(DocumentIssueService) private readonly service: DocumentIssueService,
  ) {
    this.audit = new AuditWriter(database);
  }

  @Post('document-issue-requests')
  @HttpCode(200)
  @OperationId('requestDocumentIssue')
  @Command({ operation: 'requestDocumentIssue' })
  async requestIssue(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['DocIssueRequest']): Promise<CommandResult & Record<string, unknown>> {
    // A source module acts for the whole tenant: it names the unit that drafts in the request, so a grant on a branch of the tree is not enough.
    if (!holdsOnWholeTenant(access, PERMISSIONS.requestDocumentIssue)) throw new DomainError('SCOPE_DENIED', 403);
    const input = normaliseIssueRequest(body);
    const decision = await this.service.prepare(scope.tx, scope.tenant.tenantId, input);
    switch (decision.kind) {
      case 'REPLAY':
        return this.replay(scope, decision.request);
      case 'OPEN':
        throw new DomainError('ISSUE_REQUEST_ALREADY_OPEN', 409, undefined, { extensions: requestView(decision.request) });
      case 'REJECT':
        return this.refuse(scope, input, decision.rejection);
      case 'ACCEPT': {
        const outcome = await this.service.accept(scope.tx, this.contextOf(scope.tenant, scope.tx, scope), input, decision.accepted);
        if (outcome.kind === 'REPLAY') return this.replay(scope, outcome.request);
        if (outcome.kind === 'OPEN') throw new DomainError('ISSUE_REQUEST_ALREADY_OPEN', 409, undefined, { extensions: requestView(outcome.request) });
        if (outcome.kind !== 'ACCEPTED') throw new Error('accepting a request answered a refusal');
        return { ...commandResult(scope, 'ACCEPTED', outcome.request.version, outcome.request.id), ...requestView(outcome.request), document_id: outcome.documentId };
      }
    }
  }

  @Get('documents/:id/usability')
  @OperationId('resolveDocumentReference')
  async usability(@CurrentTenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const facts = await this.database.withTenant(tenant, (tx) => this.reference.assertUsable(tx, id.toLowerCase()));
    return {
      document_id: facts.documentId,
      usable: true,
      doc_kind: facts.docKind,
      doc_type_code: facts.docTypeCode,
      effect_status: facts.effectStatus,
      symbol: facts.symbol,
      document_number: facts.documentNumber,
      number_year: facts.numberYear,
      issued_on: facts.issuedOn,
      relations: facts.relations.map((link) => ({ kind: link.kind, document_id: link.documentId })),
    };
  }

  /** The same event again: the answer it got the first time. */
  private replay(scope: CommandScope, request: IssueRequestRecord): Promise<CommandResult & Record<string, unknown>> {
    if (request.status === 'REJECTED') throw new DomainError(request.rejectCode ?? 'PAYLOAD_SCHEMA_INVALID', 422, undefined, { extensions: { replayed: true, ...requestView(request) } });
    return scope
      .audit({ action: 'doc_issue_request.replay', resourceType: 'doc_issue_request', resourceId: request.id, diff: { source_module: request.sourceModule, source_ref: request.sourceRef, issue_status: request.status } })
      .then(() => ({ ...commandResult(scope, request.status, request.version, request.id), ...requestView(request) }));
  }

  /**
   * The refusal is kept in a transaction of its own: the command answers 422 and rolls back, and the module must still find the REJECTED request and the
   * `doc.rejected.v1` it acts on.
   */
  private async refuse(scope: CommandScope, input: IssueRequestInput, rejection: Rejection): Promise<never> {
    const outcome = await this.database.withTenant(scope.tenant, (tx) => this.service.reject(tx, this.contextOf(scope.tenant, tx, scope), input, rejection));
    if (outcome.kind === 'OPEN') throw new DomainError('ISSUE_REQUEST_ALREADY_OPEN', 409, undefined, { extensions: requestView(outcome.request) });
    const request = outcome.request;
    throw new DomainError(rejection.code, 422, rejection.fields[0], { extensions: { fields: rejection.fields, ...requestView(request) } });
  }

  private contextOf(tenant: TenantContext, tx: TenantTx, scope: CommandScope): IssueContext {
    if (tx === scope.tx) return { tenantId: tenant.tenantId, actor: tenant.membershipId, audit: (entry) => scope.audit(entry), emit: (event) => scope.emit(event) };
    return {
      tenantId: tenant.tenantId,
      actor: tenant.membershipId,
      audit: (entry) => this.audit.recordInTx(tx, tenant.membershipId, { ...entry, correlationId: scope.correlationId, requestId: scope.requestId }),
      emit: (event) => enqueueOutbox(tx, { ...event, correlationId: scope.correlationId }),
    };
  }
}
