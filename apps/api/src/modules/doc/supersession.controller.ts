import { Body, Controller, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { OUTGOING_SCOPE_COLUMNS, OutgoingDocumentStore, OutgoingDraftStore, OutgoingSupersessionStore, scopePredicate } from '@machvon/db';
import type { OutgoingDocumentRecord, SupersessionDraft } from '@machvon/db';
import { DomainError, versionConflict, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { DOC_CLOCK } from './tokens';

const OUTGOING_TYPE = 'outgoing_document';
const MIN_REASON_CHARS = 10;
const MIN_TEXT_CHARS = 5;

/** A text as it is kept: NFC and trimmed, and still as long as the contract asks (blanks pass the length of the schema and say nothing). */
function textOf(raw: string, field: string, min: number): string {
  const text = raw.normalize('NFC').trim();
  if (text.length < min) throw new DomainError('VALIDATION_FAILED', 422, field);
  return text;
}

/**
 * Replacing and correcting an issued document (ST-DOC-015, DOC.md F9, BR-DOC-21, DOC-19). The command makes a new draft that carries the relation REPLACES or CORRECTS to the issued document and changes nothing in
 * the issued one: it is the issue of the new document that makes the old one REPLACED (no longer a legal basis) or CORRECTED (in force, with its correction). The number of the old document stays taken either way.
 */
@Controller()
export class OutgoingSupersessionController {
  private readonly outgoing = new OutgoingDocumentStore();
  private readonly drafts = new OutgoingDraftStore();
  private readonly supersessions = new OutgoingSupersessionStore();
  private readonly clock: () => Date;

  constructor(@Optional() @Inject(DOC_CLOCK) clock?: () => Date) {
    this.clock = clock ?? ((): Date => new Date());
  }

  @Post('outgoing-documents/:id/replacements')
  @HttpCode(200)
  @OperationId('createReplacementDocument')
  @Command({ operation: 'createReplacementDocument', versioned: true })
  async replace(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['DocReplacement'],
  ): Promise<CommandResult & Record<string, unknown>> {
    const now = this.clock();
    const document = await this.lockDocument(scope, access, id, PERMISSIONS.createReplacementDocument, now);
    if (document.version !== scope.expectedVersion) throw versionConflict(document.version);
    const reason = textOf(body.reason, 'reason', MIN_REASON_CHARS);
    const title = body.title === undefined ? undefined : textOf(body.title, 'title', 3);
    const made = await this.supersessions.createReplacement(scope.tx, document, { title, reason, actor: scope.tenant.membershipId, today: vietnamDateOf(now) });
    return this.announce(scope, document, made, 'replace', reason, now);
  }

  @Post('outgoing-documents/:id/corrections')
  @HttpCode(200)
  @OperationId('createCorrectionDocument')
  @Command({ operation: 'createCorrectionDocument', versioned: true })
  async correct(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['DocCorrection'],
  ): Promise<CommandResult & Record<string, unknown>> {
    const now = this.clock();
    const document = await this.lockDocument(scope, access, id, PERMISSIONS.createCorrectionDocument, now);
    if (document.version !== scope.expectedVersion) throw versionConflict(document.version);
    const reason = textOf(body.reason, 'reason', MIN_REASON_CHARS);
    const correctionText = textOf(body.correction_text, 'correction_text', MIN_TEXT_CHARS);
    const made = await this.supersessions.createCorrection(scope.tx, document, { correctionText, reason, actor: scope.tenant.membershipId, today: vietnamDateOf(now) });
    return this.announce(scope, document, made, 'correct', reason, now);
  }

  /** The history row of the new draft, the audit row (with the reason, never the words of the correction) and the answer. */
  private async announce(scope: CommandScope, document: OutgoingDocumentRecord, made: SupersessionDraft, action: 'replace' | 'correct', reason: string, now: Date): Promise<CommandResult & Record<string, unknown>> {
    const actor = scope.tenant.membershipId;
    const { draft } = made;
    await this.drafts.appendEvent(scope.tx, {
      outgoingDocumentId: draft.id,
      kind: 'CREATED',
      fromStatus: null,
      toStatus: 'DRAFT',
      actor,
      comment: reason,
      documentVersion: draft.version,
      occurredAt: now,
      details: { template_id: draft.templateId, relation: action === 'replace' ? 'REPLACES' : 'CORRECTS', of_document_id: document.documentId, of_outgoing_document_id: document.id },
    });
    await scope.audit({
      action: `outgoing_document.${action}`,
      resourceType: OUTGOING_TYPE,
      resourceId: document.id,
      reason,
      diff: { new_outgoing_document_id: draft.id, new_document_id: draft.documentId, relation_id: made.relationId, status: document.status, number: document.documentNumber, symbol: document.symbol },
    });
    return {
      ...commandResult(scope, 'DRAFT', draft.version, draft.id),
      document_id: draft.documentId,
      relation_id: made.relationId,
      of_outgoing_document_id: document.id,
    };
  }

  private async lockDocument(scope: CommandScope, access: EffectiveAccess, id: string, permission: string, now: Date): Promise<OutgoingDocumentRecord> {
    // A document the caller cannot see is indistinguishable from one that does not exist.
    const document = await this.outgoing.lock(scope.tx, id, (first) => scopePredicate(access, permission, now, OUTGOING_SCOPE_COLUMNS, first));
    if (document === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return document;
  }
}
