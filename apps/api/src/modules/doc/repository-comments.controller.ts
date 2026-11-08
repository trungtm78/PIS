import { Body, Controller, HttpCode, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { DocumentCommentStore, DocumentRepositoryStore, projectScope } from '@machvon/db';
import { DomainError, commentInputOf } from '@machvon/kernel';
import type { EffectiveAccess } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';

const RESOURCE = 'document_comment';

const classificationOf = (securityClass: string): 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' => (securityClass === 'PUBLIC' ? 'PUBLIC' : securityClass === 'INTERNAL' ? 'INTERNAL' : 'CONFIDENTIAL');

/**
 * Comments on a version of a project document (DOC-25, PD.02). A reviewer or an author says something about a version, or about one place of it (a citation); the comment is kept as it was said, and only its state moves:
 * resolved by someone who answers it, reopened by someone who does not accept the answer. Allowed on every version, a locked one included: a comment does not change the file. The trail and the event name the comment,
 * the version, the place and the author, never the words.
 */
@Controller()
export class DocumentCommentsController {
  private readonly documents = new DocumentRepositoryStore();
  private readonly comments = new DocumentCommentStore();

  @Post('project-document-versions/:id/comments')
  @HttpCode(200)
  @OperationId('addDocumentComment')
  @Command({ operation: 'addDocumentComment' })
  async add(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['DocumentCommentCreate']): Promise<CommandResult> {
    const now = new Date();
    const input = commentInputOf({ ...(body as unknown as Record<string, unknown>), version_id: id });
    const found = await this.documents.findVersion(scope.tx, input.versionId, projectScope(access, PERMISSIONS.addDocumentComment, now), now);
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const created = await this.comments.add(scope.tx, found.document.id, input, scope.tenant.membershipId);
    await this.record(scope, 'doc.repo.comment_added', created.id, found.document.securityClass, {
      document_id: found.document.id,
      project_id: found.document.project.id,
      version_id: created.versionId,
      version_no: found.version.versionNo,
      citation_id: created.citationId,
      parent_id: created.parentId,
      review_id: created.reviewId,
      locked_version: found.version.locked,
    }, now);
    return commandResult(scope, 'OPEN', 1, created.id);
  }

  @Post('document-comments/:id/resolve')
  @HttpCode(200)
  @OperationId('resolveDocumentComment')
  @Command({ operation: 'resolveDocumentComment' })
  async resolve(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['DocumentCommentResolve']): Promise<CommandResult> {
    const note = body.note === undefined || body.note === null || body.note === '' ? null : body.note;
    if (note !== null && (typeof note !== 'string' || note.trim().length === 0 || note.length > 2000)) throw new DomainError('VALIDATION_FAILED', 422, 'note');
    return this.move(scope, access, id, 'RESOLVED', note === null ? null : note.trim(), PERMISSIONS.resolveDocumentComment, 'doc.repo.comment_resolved');
  }

  @Post('document-comments/:id/reopen')
  @HttpCode(200)
  @OperationId('reopenDocumentComment')
  @Command({ operation: 'reopenDocumentComment' })
  async reopen(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    return this.move(scope, access, id, 'OPEN', null, PERMISSIONS.reopenDocumentComment, 'doc.repo.comment_reopened');
  }

  private async move(scope: CommandScope, access: EffectiveAccess, id: string, to: 'OPEN' | 'RESOLVED', note: string | null, permission: string, action: string): Promise<CommandResult> {
    const now = new Date();
    const comment = await this.comments.find(scope.tx, id.toLowerCase());
    // A comment of a project outside the scope of the caller is not there for them.
    const document = comment === undefined ? undefined : await this.documents.find(scope.tx, comment.documentId, projectScope(access, permission, now), now);
    if (comment === undefined || document === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const done = await this.comments.setState(scope.tx, comment.id, to, scope.tenant.membershipId, note);
    await this.record(scope, action, comment.id, document.securityClass, { document_id: document.id, project_id: document.project.id, version_id: comment.versionId, citation_id: comment.citationId, author_id: comment.authorId, has_note: note !== null }, now);
    return commandResult(scope, done.after.status, 1, comment.id);
  }

  private async record(scope: CommandScope, action: string, id: string, securityClass: string, diff: Record<string, unknown>, now: Date): Promise<void> {
    await scope.audit({ action, resourceType: RESOURCE, resourceId: id, classification: classificationOf(securityClass), diff });
    await scope.emit({
      aggregateType: RESOURCE,
      aggregateId: id,
      aggregateVersion: 1,
      type: `${action}.v1`,
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, comment_id: id, ...diff, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${RESOURCE}:${id}:${action}:${now.getTime()}`,
    });
  }
}
