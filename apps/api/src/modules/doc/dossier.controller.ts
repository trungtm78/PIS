import { Body, Controller, Get, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { DOSSIER_SCOPE_COLUMNS, DocDossierStore, DocIncomingStore, NumberRegisterStore, TenantDatabase, scopePredicate } from '@machvon/db';
import type { DossierRecord, IncomingRecord } from '@machvon/db';
import { DISPOSAL_FROM, DomainError, assertDisposable, assertFourEyes, assertIncomingTransition, disposalBlocker, planRetention, selectRetentionRule, versionConflict, vietnamDateOf } from '@machvon/kernel';
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
import { incomingScope } from './incoming.controller';
import { DOC_CLOCK } from './tokens';
import { mayActOnUnit } from './unit-scope';

const RESOURCE_TYPE = 'dossier';
const INCOMING_TYPE = 'incoming_document';
const CLASSIFICATION = 'INTERNAL';

const MANAGE = PERMISSIONS.createDossier;
const READ = PERMISSIONS.getDossier;
const ARCHIVE = PERMISSIONS.handoverDossierToArchive;
const DISPOSE = PERMISSIONS.decideDossierDisposal;
const MIN_ARCHIVE_REF = 3;
const MAX_ARCHIVE_REF = 200;
const MIN_REASON = 10;
const MAX_REASON = 2000;
const MAX_COMMENT = 1000;
const CATEGORY = /^[A-Z][A-Z0-9_]{1,59}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** What a document in a dossier says about the module a dossier is about: the subject of a hold on a project or a contract. */
const SUBJECT_MODULES: ReadonlyArray<string> = ['PRJ', 'CTR', 'PROJECT', 'CONTRACT', 'PMT', 'LND', 'ISS', 'BID', 'CAP', 'PAY', 'AST', 'QMS', 'DIS', 'MNE'];
/** The statuses of an outgoing document that can be filed (DOC.md state table: ISSUED to ACKNOWLEDGED; a corrected document is still in force and is filed too, staying CORRECTED). */
const FILEABLE_OUTGOING: ReadonlyArray<string> = ['ISSUED', 'DELIVERED', 'ACKNOWLEDGED', 'CORRECTED'];

const manageScope = (access: EffectiveAccess, now: Date, permission: string = MANAGE) => (first: number) => scopePredicate(access, permission, now, DOSSIER_SCOPE_COLUMNS, first);

/**
 * Dossiers (ST-DOC-013, DOC.md F11): an archivist opens a dossier in a unit, files issued and resolved documents into it once each, and closes it; closing finds the retention rule of the category (BR-DOC-22) or keeps the
 * dossier for ever, provisionally, until a rule is confirmed. The facts of the retention are written once.
 */
@Controller()
export class DossiersController {
  private readonly dossiers = new DocDossierStore();
  private readonly incoming = new DocIncomingStore();
  private readonly registers = new NumberRegisterStore();
  private readonly clock: () => Date;

  constructor(@Optional() @Inject(DOC_CLOCK) clock?: () => Date) {
    this.clock = clock ?? ((): Date => new Date());
  }

  @Post('dossiers')
  @HttpCode(200)
  @OperationId('createDossier')
  @Command({ operation: 'createDossier' })
  async create(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['DocDossierCreate']): Promise<CommandResult & Record<string, unknown>> {
    const now = this.clock();
    const code = body.dossier_code.trim();
    const title = body.title.trim().normalize('NFC');
    if (code.length < 3) throw new DomainError('VALIDATION_FAILED', 422, 'dossier_code');
    if (title.length < 3) throw new DomainError('VALIDATION_FAILED', 422, 'title');
    if (!Number.isInteger(body.year) || body.year < 2000 || body.year > Number(vietnamDateOf(now).slice(0, 4)) + 1) throw new DomainError('VALIDATION_FAILED', 422, 'year');
    if (!CATEGORY.test(body.category_code)) throw new DomainError('VALIDATION_FAILED', 422, 'category_code');
    // A dossier is about a module's subject, both named or neither.
    const subjectModule = body.subject_module?.trim().toUpperCase();
    if ((subjectModule === undefined) !== (body.subject_id === undefined)) throw new DomainError('VALIDATION_FAILED', 422, subjectModule === undefined ? 'subject_module' : 'subject_id');
    if (subjectModule !== undefined && !SUBJECT_MODULES.includes(subjectModule)) throw new DomainError('VALIDATION_FAILED', 422, 'subject_module');
    const unit = await this.registers.unitRef(scope.tx, body.organization_unit_id.toLowerCase());
    if (unit === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'organization_unit_id');
    if (!mayActOnUnit(access, MANAGE, unit, now)) throw new DomainError('SCOPE_DENIED', 403);
    const made = await this.dossiers.insert(scope.tx, { dossierCode: code, year: body.year, title, organizationUnitId: unit.id, subjectModule, subjectId: body.subject_id?.toLowerCase(), categoryCode: body.category_code, actor: scope.tenant.membershipId });
    await this.written(scope, made.id, 1, 'doc.dossier_created.v1', 'dossier.created', now, { dossier_code: code, year: body.year, category_code: body.category_code, organization_unit_id: unit.id });
    return { ...commandResult(scope, 'OPEN', 1, made.id), dossier_code: code };
  }

  @Post('dossiers/:id/items')
  @HttpCode(200)
  @OperationId('addDocumentToDossier')
  @Command({ operation: 'addDocumentToDossier', versioned: true })
  async addItem(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['DocDossierItem']): Promise<CommandResult & Record<string, unknown>> {
    const now = this.clock();
    const dossier = await this.heldOpen(scope, access, id, now);
    const filed = await this.fileInto(scope, access, dossier, body.document_id.toLowerCase(), body.ordinal, now, undefined);
    return { ...commandResult(scope, 'OPEN', dossier.version + 1, dossier.id), document_id: filed.documentId, ordinal: filed.ordinal };
  }

  @Post('incoming-documents/:id/filing')
  @HttpCode(200)
  @OperationId('fileIncomingDocument')
  @Command({ operation: 'fileIncomingDocument', versioned: true })
  async fileIncoming(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['DocIncomingFiling']): Promise<CommandResult & Record<string, unknown>> {
    const now = this.clock();
    if (body.dossier_id === undefined || !UUID.test(body.dossier_id)) throw new DomainError('VALIDATION_FAILED', 422, 'dossier_id');
    // The dossier is locked before the letter, as in addDocumentToDossier, so that the two ways of filing a letter never wait for each other in a circle.
    const dossier = await this.heldOpen(scope, access, body.dossier_id.toLowerCase(), now, false);
    // The letter, in the scope of the caller (a letter they cannot see does not exist), at the version they read; it must be resolved.
    const letter = await this.incoming.lock(scope.tx, id.toLowerCase(), incomingScope(access, MANAGE, now, scope.tenant.membershipId));
    if (letter === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (letter.version !== scope.expectedVersion) throw versionConflict(letter.version);
    assertIncomingTransition('file', letter.status);
    const filed = await this.fileInto(scope, access, dossier, letter.documentId, body.ordinal, now, letter);
    return { ...commandResult(scope, 'FILED', letter.version + 1, letter.id), dossier_id: dossier.id, ordinal: filed.ordinal };
  }

  @Post('dossiers/:id/closure')
  @HttpCode(200)
  @OperationId('closeDossier')
  @Command({ operation: 'closeDossier', versioned: true })
  async close(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['DocDossierClose'] | undefined): Promise<CommandResult & Record<string, unknown>> {
    const now = this.clock();
    const dossier = await this.heldOpen(scope, access, id, now);
    if (dossier.itemCount === 0) throw new DomainError('DOSSIER_EMPTY', 422);
    const closedOn = vietnamDateOf(now);
    const settlement = body?.settlement_closed_on;
    if (settlement !== undefined && (!DAY.test(settlement) || Number.isNaN(Date.parse(`${settlement}T00:00:00Z`)) || new Date(`${settlement}T00:00:00Z`).toISOString().slice(0, 10) !== settlement || settlement > closedOn)) {
      throw new DomainError('VALIDATION_FAILED', 422, 'settlement_closed_on');
    }
    // The rule of the category in force on the day of closing; nothing confirmed means the dossier is kept for ever, provisionally (BR-DOC-22).
    const rule = selectRetentionRule(await this.dossiers.publishedRules(scope.tx, dossier.categoryCode), dossier.categoryCode, closedOn);
    const plan = planRetention({ rule, closedOn, settlementClosedOn: settlement, latestIssuedOn: await this.dossiers.latestIssuedOn(scope.tx, dossier.id) });
    await this.dossiers.close(scope.tx, dossier, { closedAt: now, ruleId: plan.ruleId, classCode: plan.classCode, provisional: plan.provisional, endsOn: plan.endsOn, handoverDueOn: plan.handoverDueOn, settlementClosedOn: settlement, actor: scope.tenant.membershipId });
    const version = dossier.version + 1;
    await this.written(scope, dossier.id, version, 'doc.dossier_closed.v1', 'dossier.closed', now, {
      dossier_code: dossier.dossierCode,
      retention_rule_id: plan.ruleId,
      retention_class_code: plan.classCode,
      provisional_retention: plan.provisional,
      retention_ends_on: plan.endsOn,
      handover_due_on: plan.handoverDueOn,
    });
    return { ...commandResult(scope, 'CLOSED', version, dossier.id), retention_rule_id: plan.ruleId, retention_class_code: plan.classCode, provisional_retention: plan.provisional, retention_ends_on: plan.endsOn, handover_due_on: plan.handoverDueOn };
  }

  /**
   * The dossier goes to the archive (F11): CLOSED to HANDED_OVER and, with the reference the archive gave and the moment of the handover (not in the future, not before the closing), to ARCHIVED. The outgoing documents filed
   * in it are ARCHIVED with it. A dossier that is not closed is 422 `DOSSIER_NOT_CLOSED`.
   */
  @Post('dossiers/:id/handover')
  @HttpCode(200)
  @OperationId('handoverDossierToArchive')
  @Command({ operation: 'handoverDossierToArchive', versioned: true })
  async handover(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['DocDossierHandover']): Promise<CommandResult & Record<string, unknown>> {
    const now = this.clock();
    const archiveRef = body.archive_ref.trim();
    if (archiveRef.length < MIN_ARCHIVE_REF || archiveRef.length > MAX_ARCHIVE_REF) throw new DomainError('VALIDATION_FAILED', 422, 'archive_ref');
    const handedOverAt = new Date(body.handed_over_at);
    if (Number.isNaN(handedOverAt.getTime()) || handedOverAt.getTime() > now.getTime()) throw new DomainError('VALIDATION_FAILED', 422, 'handed_over_at');
    const dossier = await this.held(scope, access, id, now, ARCHIVE);
    if (dossier.status !== 'CLOSED') throw new DomainError('DOSSIER_NOT_CLOSED', 422, 'status', { extensions: { dossier_status: dossier.status } });
    if (dossier.closedAt !== null && handedOverAt.getTime() < new Date(dossier.closedAt).getTime()) throw new DomainError('VALIDATION_FAILED', 422, 'handed_over_at');
    const archived = await this.dossiers.handover(scope.tx, dossier, { archiveRef, handedOverAt, actor: scope.tenant.membershipId });
    // Two steps of the chain are taken in one command (HANDED_OVER is the step the archive passes through): the version moves twice.
    const version = dossier.version + 2;
    await this.written(scope, dossier.id, version, 'doc.dossier_archived.v1', 'dossier.archived', now, { dossier_code: dossier.dossierCode, archive_ref: archiveRef, handed_over_at: handedOverAt.toISOString(), documents_archived: archived });
    return { ...commandResult(scope, 'ARCHIVED', version, dossier.id), archive_ref: archiveRef, handed_over_at: handedOverAt.toISOString(), documents_archived: archived };
  }

  /**
   * A disposal is proposed for a dossier that was closed (or handed over): the retention has ended, no legal hold is on the dossier or its documents and the retention is not provisional (BR-DOC-23). The refusals are
   * 422 `DOSSIER_NOT_CLOSED`, 422 `RETENTION_PROVISIONAL`, 409 `LEGAL_HOLD_ACTIVE` (also when the retention is over) and 422 `RETENTION_NOT_EXPIRED`; a dossier whose disposal is proposed or decided is 409 `STAGE_TRANSITION_DENIED`.
   */
  @Post('dossiers/:id/disposal-proposals')
  @HttpCode(200)
  @OperationId('proposeDossierDisposal')
  @Command({ operation: 'proposeDossierDisposal', versioned: true })
  async proposeDisposal(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['DocDisposalProposal']): Promise<CommandResult> {
    const now = this.clock();
    const reason = body.reason.trim().normalize('NFC');
    if (reason.length < MIN_REASON || reason.length > MAX_REASON) throw new DomainError('VALIDATION_FAILED', 422, 'reason');
    const dossier = await this.held(scope, access, id, now, ARCHIVE);
    if (dossier.status === 'DISPOSAL_PROPOSED' || dossier.status === 'DISPOSED') throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status', { extensions: { dossier_status: dossier.status } });
    assertDisposable({ status: dossier.status, provisional: dossier.provisional, retentionEndsOn: dossier.retentionEndsOn, holdActive: await this.dossiers.holdActive(scope.tx, dossier.id), today: vietnamDateOf(now) });
    if (!DISPOSAL_FROM.includes(dossier.status)) throw new DomainError('DOSSIER_NOT_CLOSED', 422, 'status', { extensions: { dossier_status: dossier.status } });
    await this.dossiers.proposeDisposal(scope.tx, dossier, { reason, at: now, actor: scope.tenant.membershipId });
    const version = dossier.version + 1;
    await this.written(scope, dossier.id, version, 'doc.dossier_disposal_proposed.v1', 'dossier.disposal_proposed', now, { dossier_code: dossier.dossierCode, from_status: dossier.status, retention_ends_on: dossier.retentionEndsOn, reason });
    return commandResult(scope, 'DISPOSAL_PROPOSED', version, dossier.id);
  }

  /**
   * The decision of the council on a proposal, by someone who did not propose it (403 `SELF_APPROVAL_DENIED`). Approving needs the document of the decision (422 `DECISION_DOCUMENT_REQUIRED`) and a dossier that is under no legal
   * hold by now (409 `LEGAL_HOLD_ACTIVE`): it is marked DISPOSED, nothing is deleted here (the event tells the archive process of the tenant). Rejecting sends the dossier back to the state it was proposed from.
   */
  @Post('dossiers/:id/disposal-decision')
  @HttpCode(200)
  @OperationId('decideDossierDisposal')
  @Command({ operation: 'decideDossierDisposal', versioned: true })
  async decideDisposal(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['DocDisposalDecision']): Promise<CommandResult> {
    const now = this.clock();
    const approve = body.decision === 'APPROVE';
    const comment = body.comment === undefined || body.comment.trim() === '' ? undefined : body.comment.trim().normalize('NFC');
    if (comment !== undefined && comment.length > MAX_COMMENT) throw new DomainError('VALIDATION_FAILED', 422, 'comment');
    const dossier = await this.held(scope, access, id, now, DISPOSE);
    if (dossier.status !== 'DISPOSAL_PROPOSED' || dossier.disposal === null) throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status', { extensions: { dossier_status: dossier.status } });
    assertFourEyes(dossier.disposal.proposedBy, scope.tenant.membershipId);
    const decisionDocumentId = body.council_decision_document_id?.toLowerCase();
    if (approve) {
      if (decisionDocumentId === undefined || !(await this.dossiers.decisionDocumentUsable(scope.tx, decisionDocumentId))) throw new DomainError('DECISION_DOCUMENT_REQUIRED', 422, 'council_decision_document_id');
      // A hold put on the dossier (or on a document in it) after the proposal stops the disposal as well.
      if (await this.dossiers.holdActive(scope.tx, dossier.id)) throw new DomainError('LEGAL_HOLD_ACTIVE', 409);
    } else if (decisionDocumentId !== undefined) throw new DomainError('VALIDATION_FAILED', 422, 'council_decision_document_id');
    await this.dossiers.decideDisposal(scope.tx, dossier, { approve, councilDecisionDocumentId: decisionDocumentId, comment, at: now, actor: scope.tenant.membershipId });
    const version = dossier.version + 1;
    const status = approve ? 'DISPOSED' : dossier.disposal.fromStatus;
    await this.written(scope, dossier.id, version, approve ? 'doc.dossier_disposed.v1' : 'doc.dossier_disposal_rejected.v1', approve ? 'dossier.disposed' : 'dossier.disposal_rejected', now, {
      dossier_code: dossier.dossierCode,
      decision: body.decision,
      proposed_by: dossier.disposal.proposedBy,
      proposed_at: dossier.disposal.proposedAt,
      // A rejection clears the proposal from the dossier: the reason stays in the trail.
      proposed_reason: dossier.disposal.reason,
      council_decision_document_id: decisionDocumentId ?? null,
      comment: comment ?? null,
      to_status: status,
    });
    return commandResult(scope, status, version, dossier.id);
  }

  /** The dossier locked in the scope of the caller for the permission of the step, at the version they read. */
  private async held(scope: CommandScope, access: EffectiveAccess, id: string, now: Date, permission: string): Promise<DossierRecord> {
    const dossier = await this.dossiers.lock(scope.tx, id, manageScope(access, now, permission));
    if (dossier === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (dossier.version !== scope.expectedVersion) throw versionConflict(dossier.version);
    return dossier;
  }

  /** The dossier locked in the scope of the caller, at the version they read, and open (409 `DOSSIER_NOT_OPEN`). */

  private async heldOpen(scope: CommandScope, access: EffectiveAccess, id: string, now: Date, checkVersion = true): Promise<DossierRecord> {
    const dossier = await this.dossiers.lock(scope.tx, id, manageScope(access, now));
    if (dossier === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (checkVersion && dossier.version !== scope.expectedVersion) throw versionConflict(dossier.version);
    if (dossier.status !== 'OPEN') throw new DomainError('DOSSIER_NOT_OPEN', 409, 'status', { extensions: { dossier_status: dossier.status } });
    return dossier;
  }

  /**
   * Puts a document into the dossier and takes it to FILED in its own chain: an issued outgoing document (ISSUED to ACKNOWLEDGED) or a resolved incoming letter. A document that the caller may not file, or does not see, is as
   * good as none (422 `document_id`); one that is in a dossier already is 422 `DOCUMENT_ALREADY_IN_DOSSIER`.
   */
  private async fileInto(scope: CommandScope, access: EffectiveAccess, dossier: DossierRecord, documentId: string, ordinal: number | undefined, now: Date, known: IncomingRecord | undefined): Promise<{ documentId: string; ordinal: number }> {
    if (ordinal !== undefined && (!Number.isInteger(ordinal) || ordinal < 1)) throw new DomainError('VALIDATION_FAILED', 422, 'ordinal');
    const found = await this.dossiers.fileable(scope.tx, documentId);
    if (found === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'document_id');
    // First whether the caller may deal with the document at all: a document out of reach is as good as none, whatever its state (nothing of it is told).
    let letter = known;
    if (found.docKind === 'INCOMING') {
      letter ??= await this.incoming.lock(scope.tx, found.incomingId ?? '00000000-0000-0000-0000-000000000000', incomingScope(access, MANAGE, now, scope.tenant.membershipId));
      if (letter === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'document_id');
    } else if (found.docKind === 'OUTGOING') {
      // The issuing unit must be in the reach of the archivist as well.
      if (found.issuerUnitId !== null && found.issuerUnitPath !== null && !mayActOnUnit(access, MANAGE, { id: found.issuerUnitId, path: found.issuerUnitPath }, now)) throw new DomainError('VALIDATION_FAILED', 422, 'document_id');
    } else throw new DomainError('VALIDATION_FAILED', 422, 'document_id');
    // A document is in one dossier only (also the one that is FILED by now).
    if ((await this.dossiers.dossierOf(scope.tx, found.id)) !== undefined) throw new DomainError('DOCUMENT_ALREADY_IN_DOSSIER', 422, 'document_id');
    if (letter !== undefined) assertIncomingTransition('file', letter.status);
    else if (found.outgoingStatus === null || !FILEABLE_OUTGOING.includes(found.outgoingStatus)) throw new DomainError('DOCUMENT_NOT_FILEABLE', 422, 'document_id');

    const item = await this.dossiers.addItem(scope.tx, dossier, { documentId: found.id, ordinal, actor: scope.tenant.membershipId });
    const version = dossier.version + 1;
    await this.written(scope, dossier.id, version, 'doc.dossier_item_added.v1', 'dossier.item_added', now, { document_id: found.id, doc_kind: found.docKind, ordinal: item.ordinal });
    if (letter !== undefined) {
      await this.incoming.markFiled(scope.tx, letter.id, { expectedVersion: letter.version, actor: scope.tenant.membershipId });
      const filedVersion = letter.version + 1;
      await scope.audit({ action: 'incoming_document.filed', resourceType: INCOMING_TYPE, resourceId: letter.id, classification: CLASSIFICATION, diff: { to_status: 'FILED', from_status: letter.status, dossier_id: dossier.id } });
      await scope.emit({
        aggregateType: INCOMING_TYPE,
        aggregateId: letter.id,
        aggregateVersion: filedVersion,
        type: 'doc.incoming_filed.v1',
        schemaVersion: 1,
        payload: { tenant_id: scope.tenant.tenantId, document_id: found.id, incoming_document_id: letter.id, dossier_id: dossier.id, version: filedVersion, status: 'FILED', actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
        eventKey: `${INCOMING_TYPE}:${letter.id}:${filedVersion}`,
      });
    } else if (!(await this.dossiers.markOutgoingFiled(scope.tx, found.id, { actor: scope.tenant.membershipId, dossierId: dossier.id, ordinal: item.ordinal, at: now }))) {
      // The document was recalled (or changed) after it was read: nothing of this filing is kept.
      throw new DomainError('DOCUMENT_NOT_FILEABLE', 422, 'document_id');
    }
    return { documentId: found.id, ordinal: item.ordinal };
  }

  /** The audit row and the event of a step: ids, the facts of the step; never the title of the dossier or of a document. */
  private async written(scope: CommandScope, id: string, version: number, type: string, action: string, now: Date, facts: Record<string, unknown>): Promise<void> {
    await scope.audit({ action, resourceType: RESOURCE_TYPE, resourceId: id, classification: CLASSIFICATION, diff: facts });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: id,
      aggregateVersion: version,
      type,
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, dossier_id: id, version, ...facts, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${RESOURCE_TYPE}:${id}:${version}`,
    });
  }
}

/** The dossiers and the retention rules, in the scope of the caller. */
@Controller()
export class DossierReadsController {
  private readonly dossiers = new DocDossierStore();
  private readonly clock: () => Date;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Optional() @Inject(DOC_CLOCK) clock?: () => Date,
  ) {
    this.clock = clock ?? ((): Date => new Date());
  }

  @Get('dossiers')
  @OperationId('listDossiers')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('status') status?: unknown,
    @Query('subject_module') subjectModule?: unknown,
    @Query('subject_id') subjectId?: unknown,
    @Query('year') year?: unknown,
    @Query('cursor') cursor?: unknown,
    @Query('limit') limit?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    if (status !== undefined && !(typeof status === 'string' && ['OPEN', 'CLOSED', 'HANDED_OVER', 'ARCHIVED', 'DISPOSAL_PROPOSED', 'DISPOSED'].includes(status))) throw new DomainError('VALIDATION_FAILED', 422, 'status');
    if (subjectModule !== undefined && !(typeof subjectModule === 'string' && SUBJECT_MODULES.includes(subjectModule.toUpperCase()))) throw new DomainError('VALIDATION_FAILED', 422, 'subject_module');
    if (subjectId !== undefined && !(typeof subjectId === 'string' && UUID.test(subjectId))) throw new DomainError('VALIDATION_FAILED', 422, 'subject_id');
    if (year !== undefined && !(typeof year === 'string' && /^\d{4}$/.test(year))) throw new DomainError('VALIDATION_FAILED', 422, 'year');
    const page = parsePageRequest(limit, cursor);
    const now = this.clock();
    const found = await this.database.withTenant(tenant, async (tx) => {
      const listed = await this.dossiers.list(
        tx,
        { status: status as string | undefined, subjectModule: (subjectModule as string | undefined)?.toUpperCase(), subjectId: (subjectId as string | undefined)?.toLowerCase(), year: year === undefined ? undefined : Number(year) },
        { limit: page.limit, after: page.after },
        (first) => scopePredicate(access, READ, now, DOSSIER_SCOPE_COLUMNS, first),
      );
      return { ...listed, held: await this.dossiers.holdsActive(tx, listed.records.map((record) => record.id)) };
    });
    const today = vietnamDateOf(now);
    return {
      items: found.records.map((record) => ({ ...view(record, access, now, tenant.membershipId), ...holdFacts(record, found.held.has(record.id), today) })), next_cursor: found.next === undefined ? null : encodeCursor(found.next),
      as_of: now.toISOString(),
    };
  }

  @Get('dossiers/:id')
  @OperationId('getDossier')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = this.clock();
    const found = await this.database.withTenant(tenant, async (tx) => {
      const record = await this.dossiers.find(tx, id.toLowerCase(), (first) => scopePredicate(access, READ, now, DOSSIER_SCOPE_COLUMNS, first));
      if (record === undefined) return undefined;
      return { record, items: await this.dossiers.items(tx, record.id), held: await this.dossiers.holdActive(tx, record.id) };
    });
    // A dossier in another tenant or outside the scope of the caller is indistinguishable from one that does not exist.
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const { record } = found;
    return {
      ...view(record, access, now, tenant.membershipId),
      items: found.items.map((item) => ({ id: item.id, document_id: item.documentId, ordinal: item.ordinal, title: item.title, doc_kind: item.docKind, doc_type_code: item.docTypeCode, classification: item.classification, issued_on: item.issuedOn, added_at: item.addedAt })),
      ...holdFacts(record, found.held, vietnamDateOf(now)),
    };
  }

  @Get('document-retention-rules')
  @OperationId('listDocumentRetentionRules')
  async rules(
    @CurrentTenant() tenant: TenantContext,
    @Query('rule_set') ruleSet?: unknown,
    @Query('category_code') categoryCode?: unknown,
    @Query('cursor') cursor?: unknown,
    @Query('limit') limit?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null }> {
    if (ruleSet !== undefined && !(typeof ruleSet === 'string' && ['TT74_2025_BTC', 'TT10_2022_BNV', 'TENANT_CUSTOM'].includes(ruleSet))) throw new DomainError('VALIDATION_FAILED', 422, 'rule_set');
    if (categoryCode !== undefined && !(typeof categoryCode === 'string' && CATEGORY.test(categoryCode))) throw new DomainError('VALIDATION_FAILED', 422, 'category_code');
    const page = parsePageRequest(limit, cursor);
    const found = await this.database.withTenant(tenant, (tx) => this.dossiers.listRules(tx, { ruleSet: ruleSet as string | undefined, categoryCode: categoryCode as string | undefined }, { limit: page.limit, after: page.after }));
    return {
      items: found.records.map((rule) => ({
        id: rule.id,
        rule_set: rule.ruleSet,
        category_code: rule.categoryCode,
        class_code: rule.classCode,
        retention_years: rule.retentionYears,
        start_basis: rule.startBasis,
        handover_months: rule.handoverMonths,
        end_action: rule.endAction,
        legal_basis: rule.legalBasis,
        legal_confirmation_ref: rule.legalConfirmationRef,
        confirmation_status: rule.confirmationStatus,
        precedence: rule.precedence,
        effective_from: rule.effectiveFrom,
        effective_until: rule.effectiveUntil,
        status: rule.status,
        created_by: { id: rule.createdBy, name: rule.createdByName },
        approved_by: rule.approvedBy === null ? null : { id: rule.approvedBy, name: rule.approvedByName },
        legal_confirmed_by: rule.legalConfirmedBy === null ? null : { id: rule.legalConfirmedBy, name: rule.legalConfirmedByName },
        version: rule.version,
      })),
      next_cursor: found.next === undefined ? null : encodeCursor(found.next),
    };
  }
}

/** Whether a legal hold is on the dossier and what stops its disposal now (BR-DOC-23), if anything: the hold indicator of the list and of the detail. */
function holdFacts(record: DossierRecord, held: boolean, today: string): Record<string, unknown> {
  return { legal_hold_active: held, disposal_blocker: disposalBlocker({ status: record.status, provisional: record.provisional, retentionEndsOn: record.retentionEndsOn, holdActive: held, today }) ?? null };
}

/** One dossier as the reads show it, with what the caller may do now. */
function view(record: DossierRecord, access: EffectiveAccess, now: Date, membershipId: string): Record<string, unknown> {
  const mayAct = (permission: string): boolean => mayActOnUnit(access, permission, { id: record.organizationUnitId, path: record.unitPath }, now);
  const mayManage = mayAct(MANAGE);
  return {
    id: record.id,
    dossier_code: record.dossierCode,
    year: record.year,
    title: record.title,
    organization_unit: { id: record.organizationUnitId, name: record.unitName },
    subject_module: record.subjectModule,
    subject_id: record.subjectId,
    category_code: record.categoryCode,
    status: record.status,
    retention: {
      rule_id: record.retentionRuleId,
      rule_set: record.retentionRuleSet,
      class_code: record.retentionClassCode,
      provisional: record.provisional,
      ends_on: record.retentionEndsOn,
    },
    closed_at: record.closedAt,
    settlement_closed_on: record.settlementClosedOn,
    handover_due_on: record.handoverDueOn,
    handed_over_at: record.handedOverAt,
    archive_ref: record.archiveRef,
    disposal:
      record.disposal === null
        ? null
        : {
            proposed_by: record.disposal.proposedBy,
            proposed_at: record.disposal.proposedAt,
            reason: record.disposal.reason,
            from_status: record.disposal.fromStatus,
            decided_by: record.disposal.decidedBy,
            decided_at: record.disposal.decidedAt,
            council_decision_document_id: record.disposal.councilDecisionDocumentId,
            comment: record.disposal.comment,
          },
    item_count: record.itemCount,
    version: record.version,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    actions: {
      addDocument: record.status === 'OPEN' && mayManage,
      close: record.status === 'OPEN' && record.itemCount > 0 && mayManage,
      handover: record.status === 'CLOSED' && mayAct(ARCHIVE),
      proposeDisposal: DISPOSAL_FROM.includes(record.status) && mayAct(ARCHIVE),
      // The one who proposed the disposal is not the one who decides it: the action is not offered to them.
      decideDisposal: record.status === 'DISPOSAL_PROPOSED' && record.disposal?.proposedBy !== membershipId && mayAct(DISPOSE),
    },
  };
}
