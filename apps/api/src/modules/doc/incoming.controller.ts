import { createHash } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { AuditWriter, DocIncomingStore, DocumentStore, NIL_RESOURCE_ID, NumberRegisterStore, OUTGOING_SCOPE_COLUMNS, OutgoingDocumentStore, REGISTER_SCOPE_COLUMNS, TenantDatabase, WorkCalendarStore, loadAccessIn, scopePredicate } from '@machvon/db';
import type { IncomingAssignment, IncomingRecord, RegisterRecord, TenantTx } from '@machvon/db';
import { DomainError, INCOMING_CHANNELS, INCOMING_STATUSES, INCOMING_URGENCIES, assertIncomingTransition, activeGrants, holdsPermission, isWorkable, stateSecretMarking, versionConflict, vietnamDateOf, workingDaysLate } from '@machvon/kernel';
import type { EffectiveAccess, IncomingChannel, IncomingStatus, IncomingUrgency, TenantContext, WorkCalendarSource } from '@machvon/kernel';
import { FileService } from '../files';
import { DOCUMENT_FILE_PORT } from './file-port';
import type { DocumentFilePort } from './file-port';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { assertPdf, pageCountOf } from './external-signature';
import { DOC_CLOCK } from './tokens';
import { mayActOnUnit } from './unit-scope';

const RESOURCE_TYPE = 'incoming_document';
const CLASSIFICATION = 'INTERNAL';
/** The calendar the deadlines of letters are counted by (ADM work calendar). */
export const INCOMING_CALENDAR = 'VN-STD';
const SYMBOL_PATTERN = '{number}/{unit}';
const PDF_MIME = 'application/pdf';

const REGISTER = PERMISSIONS.registerIncomingDocument;
const ASSIGN = PERMISSIONS.assignIncomingDocument;
const PROCESS = PERMISSIONS.startIncomingDocumentProcessing;
const READ = PERMISSIONS.getIncomingDocument;

/**
 * The scope of a letter for a permission: the letter is in reach when the unit of its register or the unit it was given to lies in a scope of a grant that carries the permission, when the caller took it in or is its handler,
 * and, for a letter that has no register yet (its unit is chosen by the register it is entered in), when the permission is held at all. Compiled over the aliases `ru` (the unit of the register), `au` (the unit it was given to) and `i` of the queries of the store.
 */
export function incomingScope(access: EffectiveAccess, permission: string, now: Date, membershipId: string) {
  return (first: number) => {
    const home = scopePredicate(access, permission, now, { unitPath: 'ru.path', unitId: 'ru.id' }, first);
    const given = scopePredicate(access, permission, now, { unitPath: 'au.path', unitId: 'au.id' }, first + home.params.length);
    const me = first + home.params.length + given.params.length;
    return {
      sql: `(${home.sql.replace(/^true$/, 'ru.id is not null')} or ${given.sql.replace(/^true$/, 'au.id is not null')} or i.received_by = $${me}::uuid or i.assignee_user_id = (select user_account_id from machvon.tenant_user_directory where membership_id = $${me}::uuid) or (i.register_id is null and $${me + 1}::boolean))`,
      params: [...home.params, ...given.params, membershipId, holdsAnywhere(access, permission, now)],
    };
  };
}

/** Whether any active grant of the caller carries the permission, over whatever scope: the unit of a letter that was only received is chosen by the register it is entered in. */
export function holdsAnywhere(access: EffectiveAccess, permission: string, now: Date): boolean {
  return activeGrants(access, now).some((grant) => holdsPermission(new Set(grant.permissions), permission));
}

/** The letter as openapi.json exposes it (x-exposure dto): an allowlist. The label of lateness is the screen's to word; the server gives the days. */
function incomingView(record: IncomingRecord, extra: { overdueDays: number | null; actions: Record<string, boolean>; assignments?: IncomingAssignment[]; hiddenLinks?: ReadonlySet<string> }): Record<string, unknown> {
  return {
    id: record.id,
    document_id: record.documentId,
    status: record.status,
    channel: record.channel,
    title: record.title,
    doc_type_code: record.docTypeCode,
    classification: record.classification,
    received_at: record.receivedAt,
    register: record.registerId === null ? null : { id: record.registerId, code: record.registerCode },
    number: record.number,
    symbol: record.symbol,
    original_symbol: record.originalSymbol,
    original_issued_on: record.originalIssuedOn,
    sender_name: record.senderName,
    urgency: record.urgency,
    due_on: record.dueOn,
    leader_directive: record.leaderDirective,
    assigned_unit: record.assignedUnitId === null ? null : { id: record.assignedUnitId, name: record.assignedUnitName },
    assignee: record.assigneeUserId === null ? null : { user_id: record.assigneeUserId, display_name: record.assigneeName },
    resolution_summary: record.resolutionSummary,
    resolved_at: record.resolvedAt,
    late_days: record.lateDays,
    response_outgoing_id: record.responseOutgoingId,
    // The link to the letter this one looks like is shown only if the reader may read that letter.
    duplicate_of_id: record.duplicateOfId !== null && extra.hiddenLinks?.has(record.duplicateOfId) === true ? null : record.duplicateOfId,
    duplicate_override_reason: record.duplicateOverrideReason,
    rejection_reason: record.rejectionReason,
    // Overdue now: assigned or being processed and past the deadline (a letter resolved late keeps its late days and is not overdue any more).
    is_overdue: record.isOverdue && isWorkable(record.status),
    overdue_since: record.overdueSince,
    overdue_days: extra.overdueDays,
    file_sha256: record.fileSha256,
    version: record.version,
    updated_at: record.updatedAt,
    actions: extra.actions,
    ...(extra.assignments === undefined
      ? {}
      : {
          assignments: extra.assignments.map((entry) => ({
            id: entry.id,
            assigned_unit: { id: entry.assignedUnitId, name: entry.assignedUnitName },
            assignee: entry.assigneeUserId === null ? null : { user_id: entry.assigneeUserId, display_name: entry.assigneeName },
            leader_directive: entry.leaderDirective,
            due_on: entry.dueOn,
            assigned_at: entry.assignedAt,
          })),
        }),
  };
}

/**
 * Incoming documents (ST-DOC-011, DOC.md F10, BR-DOC-18, BR-DOC-20). A letter is received from a scan, an e-mail, LGSP or an upload (the file must be a clean PDF that the pipeline of uploads has already judged), registered in the
 * incoming register of a unit (which gives it its number under the lock of the register), assigned to a unit and a handler with a deadline, worked and resolved by the handler and no one else, and filed. A letter that declares a level
 * of state secret is not taken in at all; one that looks like a letter already there is refused unless the clerk says why it is taken in again. Everything happens in the transaction of the command with its audit row and its event.
 */
@Controller()
export class IncomingController {
  private readonly incoming = new DocIncomingStore();
  private readonly outgoing = new OutgoingDocumentStore();
  private readonly documents = new DocumentStore();
  private readonly registers = new NumberRegisterStore();
  private readonly calendars = new WorkCalendarStore();
  private readonly audit: AuditWriter;
  private readonly clock: () => Date;

  constructor(
    @Inject(TenantDatabase) database: TenantDatabase,
    @Inject(FileService) private readonly files: FileService,
    @Inject(DOCUMENT_FILE_PORT) private readonly stored: DocumentFilePort,
    @Optional() @Inject(DOC_CLOCK) clock?: () => Date,
  ) {
    this.audit = new AuditWriter(database);
    this.clock = clock ?? ((): Date => new Date());
  }

  @Post('incoming-documents')
  @HttpCode(200)
  @OperationId('receiveIncomingDocument')
  @Command({ operation: 'receiveIncomingDocument' })
  async receive(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['DocIncomingReceive']): Promise<CommandResult & Record<string, unknown>> {
    const now = this.clock();
    // BR-DOC-20: a letter marked with a level of state secret is not kept or stored here; the refusal is audited as DENIED (it survives the rollback) and nothing is created.
    for (const [field, value] of [
      ['title', body.title],
      ['original_symbol', body.original_symbol],
      ['sender_name', body.sender_name],
    ] as const) {
      if (value !== undefined && stateSecretMarking(value)) {
        await this.audit.recordDenied(scope.tenant, { action: 'incoming_document.receive', resourceType: RESOURCE_TYPE, resourceId: NIL_RESOURCE_ID, diff: { reason: 'STATE_SECRET_NOT_SUPPORTED', field }, correlationId: scope.correlationId, requestId: scope.requestId });
        throw new DomainError('STATE_SECRET_NOT_SUPPORTED', 422, field);
      }
    }
    const channel = INCOMING_CHANNELS.find((candidate) => candidate === body.channel) as IncomingChannel;
    const urgency = (INCOMING_URGENCIES.find((candidate) => candidate === body.urgency) ?? 'NORMAL') as IncomingUrgency;
    const override = body.duplicate_override_reason === undefined ? undefined : body.duplicate_override_reason.normalize('NFC').trim();
    // The reason counts without the spaces around it.
    if (override !== undefined && override.length < 10) throw new DomainError('VALIDATION_FAILED', 422, 'duplicate_override_reason');
    const duplicate = await this.incoming.duplicateOf(scope.tx, { senderName: body.sender_name, originalSymbol: body.original_symbol, originalIssuedOn: body.original_issued_on });
    // The letter is refused wherever the other one is, but it is named only to someone who may read it.
    if (duplicate !== undefined && override === undefined) {
      const visible = (await this.incoming.find(scope.tx, duplicate.id, incomingScope(access, READ, now, scope.tenant.membershipId))) !== undefined;
      throw new DomainError('INCOMING_DUPLICATE_SUSPECTED', 409, 'original_symbol', visible ? { extensions: { duplicate_of_id: duplicate.id, duplicate_status: duplicate.status } } : undefined);
    }
    if (duplicate === undefined && override !== undefined) throw new DomainError('VALIDATION_FAILED', 422, 'duplicate_override_reason');
    const docType = await this.documents.docTypeFor(scope.tx, body.doc_type_code, vietnamDateOf(now));
    if (docType === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'doc_type_code');

    // The file: the pipeline of uploads has judged and scanned it (404 for a key that is not this tenant's, 422 FILE_NOT_CLEAN, 409 SCAN_PENDING); here it must be a PDF and the hash the client says must be its own.
    const uploaded = await this.files.download(scope.tenant, body.file_object_key);
    const bytes = Buffer.from(uploaded.bytes);
    assertPdf(bytes);
    const checksum = createHash('sha256').update(bytes).digest('hex');
    if (checksum !== body.file_sha256) throw new DomainError('VALIDATION_FAILED', 422, 'file_sha256');
    const pages = await pageCountOf(bytes);

    const classification = body.classification ?? 'INTERNAL';
    const document = await this.documents.insertDocument(scope.tx, { docKind: 'INCOMING', docTypeCode: body.doc_type_code, title: body.title, classification, createdBy: scope.tenant.membershipId });
    // The file is kept where the documents are served from (the download of a version reads that store), under a key that holds its digest: a step that is repeated writes the same object.
    const objectKey = `tenants/${scope.tenant.tenantId}/documents/${document.id}-${checksum}.pdf`;
    await this.stored.put(objectKey, bytes, PDF_MIME);
    const version = await this.documents.appendVersion(scope.tx, {
      documentId: document.id,
      objectKey,
      checksum,
      mime: PDF_MIME,
      pageCount: pages,
      classification,
      stage: 'RECEIVED_SCAN',
      byteLength: bytes.length,
      createdBy: scope.tenant.membershipId,
    });
    await this.documents.setScanResult(scope.tx, version.id, 'CLEAN');
    const letter = await this.incoming.insert(scope.tx, {
      documentId: document.id,
      channel,
      receivedAt: now,
      receivedBy: scope.tenant.membershipId,
      originalSymbol: body.original_symbol,
      originalIssuedOn: body.original_issued_on,
      senderName: body.sender_name.normalize('NFC').trim(),
      urgency,
      duplicateOfId: duplicate?.id,
      duplicateOverrideReason: override,
    });
    await this.written(scope, letter.id, document.id, 'RECEIVED', 1, 'incoming_document.received', 'doc.incoming_received.v1', now, { channel, urgency, duplicate_of_id: duplicate?.id ?? null, page_count: pages });
    return { ...commandResult(scope, 'RECEIVED', 1, letter.id), document_id: document.id, version_id: version.id };
  }

  @Post('incoming-documents/:id/registration')
  @HttpCode(200)
  @OperationId('registerIncomingDocument')
  @Command({ operation: 'registerIncomingDocument', versioned: true })
  async register(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['DocIncomingRegister'] | undefined): Promise<CommandResult & Record<string, unknown>> {
    const now = this.clock();
    const letter = await this.held(scope, id, incomingScope(access, REGISTER, now, scope.tenant.membershipId));
    assertIncomingTransition('register', letter.status);
    // The register of the year of reception, in a unit the caller may register in; with none named, the only one that is open there.
    const registerScope = (first: number) => scopePredicate(access, REGISTER, now, REGISTER_SCOPE_COLUMNS, first);
    let registerId = body?.register_id?.toLowerCase();
    // A register that restricts the types of document takes only those.
    // (A mirrored register is kept by another system: it gives no numbers here.)
    const takes = (candidate: { mode: string; scopeDocTypes: readonly string[] }): boolean => candidate.mode === 'MANAGED' && (candidate.scopeDocTypes.length === 0 || candidate.scopeDocTypes.includes(letter.docTypeCode));
    if (registerId === undefined) {
      const open: RegisterRecord[] = [];
      for (let after: { code: string; id: string } | undefined; ; ) {
        const page = await this.registers.listRegisters(scope.tx, { year: Number(vietnamDateOf(now).slice(0, 4)), direction: 'INCOMING', status: 'OPEN', limit: 100, after }, registerScope);
        open.push(...page.filter(takes));
        const last = page.at(-1);
        if (page.length < 100 || last === undefined || open.length >= 20) break;
        after = { code: last.registerCode, id: last.id };
      }
      if (open.length === 0) throw new DomainError('REGISTER_NOT_OPEN', 409, 'register_id');
      // Several are open: the caller is told which, from the registers of their own scope (reading the registers is another right).
      if (open.length > 1) throw new DomainError('VALIDATION_FAILED', 422, 'register_id', { extensions: { open_registers: open.map((candidate) => ({ id: candidate.id, register_code: candidate.registerCode, name: candidate.name })) } });
      registerId = open[0]?.id;
    }
    const register = registerId === undefined ? undefined : await this.registers.findRegister(scope.tx, registerId, registerScope);
    if (register === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (register.direction !== 'INCOMING' || !takes(register)) throw new DomainError('VALIDATION_FAILED', 422, 'register_id');
    // The number is allocated under the lock of the register, in this transaction: a refusal below gives it back.
    const allocation = await this.registers.allocateNumber(scope.tx, { registerId: register.id, documentId: letter.documentId, issuedAt: now, symbolPattern: SYMBOL_PATTERN, parts: { unit: register.registerCode }, allocatedBy: scope.tenant.membershipId });
    await this.incoming.markRegistered(scope.tx, id, { expectedVersion: scope.expectedVersion ?? 0, registerId: register.id, actor: scope.tenant.membershipId });
    const version = letter.version + 1;
    await this.written(scope, id, letter.documentId, 'REGISTERED', version, 'incoming_document.registered', 'doc.incoming_registered.v1', now, { register_id: register.id, register_code: register.registerCode, number: allocation.number, symbol: allocation.symbol, from_status: letter.status });
    return { ...commandResult(scope, 'REGISTERED', version, id), number: allocation.number, symbol: allocation.symbol, register_id: register.id };
  }

  @Post('incoming-documents/:id/assignment')
  @HttpCode(200)
  @OperationId('assignIncomingDocument')
  @Command({ operation: 'assignIncomingDocument', versioned: true })
  async assign(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['DocIncomingAssign']): Promise<CommandResult> {
    const now = this.clock();
    const letter = await this.held(scope, id, incomingScope(access, ASSIGN, now, scope.tenant.membershipId));
    assertIncomingTransition('assign', letter.status);
    const today = vietnamDateOf(now);
    if (body.due_on !== undefined && body.due_on < today) throw new DomainError('DUE_DATE_IN_PAST', 422, 'due_on');
    // The unit and the handler are in the scope of whoever assigns: the unit is below a unit they may assign in, and the handler is a member who may work letters there.
    const unit = await this.registers.unitRef(scope.tx, body.assigned_unit_id);
    if (unit === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'assigned_unit_id');
    if (!mayActOnUnit(access, ASSIGN, unit, now)) throw new DomainError('ASSIGNEE_OUT_OF_SCOPE', 422, 'assigned_unit_id');
    if (body.assignee_user_id !== undefined && !(await this.mayWork(scope.tx, body.assignee_user_id, unit, now))) throw new DomainError('ASSIGNEE_OUT_OF_SCOPE', 422, 'assignee_user_id');
    await this.incoming.markAssigned(scope.tx, id, {
      expectedVersion: scope.expectedVersion ?? 0,
      unitId: unit.id,
      assigneeUserId: body.assignee_user_id?.toLowerCase(),
      directive: body.leader_directive === undefined || body.leader_directive.trim() === '' ? undefined : body.leader_directive.trim(),
      dueOn: body.due_on,
      actor: scope.tenant.membershipId,
    });
    const version = letter.version + 1;
    await this.written(scope, id, letter.documentId, 'ASSIGNED', version, 'incoming_document.assigned', 'doc.incoming_assigned.v1', now, {
      assigned_unit_id: unit.id,
      assignee_user_id: body.assignee_user_id?.toLowerCase() ?? null,
      due_on: body.due_on ?? null,
      from_status: letter.status,
      reassigned: letter.status !== 'REGISTERED',
    });
    return commandResult(scope, 'ASSIGNED', version, id);
  }

  @Post('incoming-documents/:id/processing')
  @HttpCode(200)
  @OperationId('startIncomingDocumentProcessing')
  @Command({ operation: 'startIncomingDocumentProcessing', versioned: true })
  async startProcessing(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    const now = this.clock();
    const letter = await this.held(scope, id, incomingScope(access, PROCESS, now, scope.tenant.membershipId));
    assertIncomingTransition('startProcessing', letter.status);
    await this.assertHandler(scope, access, letter, now);
    await this.incoming.markProcessing(scope.tx, id, { expectedVersion: scope.expectedVersion ?? 0, actor: scope.tenant.membershipId });
    const version = letter.version + 1;
    await this.written(scope, id, letter.documentId, 'PROCESSING', version, 'incoming_document.processing', 'doc.incoming_processing.v1', now, { from_status: letter.status });
    return commandResult(scope, 'PROCESSING', version, id);
  }

  @Post('incoming-documents/:id/resolution')
  @HttpCode(200)
  @OperationId('resolveIncomingDocument')
  @Command({ operation: 'resolveIncomingDocument', versioned: true })
  async resolve(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['DocIncomingResolve']): Promise<CommandResult & Record<string, unknown>> {
    const now = this.clock();
    const letter = await this.held(scope, id, incomingScope(access, PROCESS, now, scope.tenant.membershipId));
    assertIncomingTransition('resolve', letter.status);
    if (body.resolution_summary.trim().length < 5) throw new DomainError('VALIDATION_FAILED', 422, 'resolution_summary');
    await this.assertHandler(scope, access, letter, now);
    const response = body.response_outgoing_id?.toLowerCase();
    if (response !== undefined) {
      // The answer is a letter of ours that was issued (status ISSUED or later), not a draft, and one that the caller may read: another unit's letter is as good as none.
      const issued = await this.outgoing.find(scope.tx, response, (first) => scopePredicate(access, PERMISSIONS.getOutgoingDocument, now, OUTGOING_SCOPE_COLUMNS, first));
      if (issued === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'response_outgoing_id');
      if (!['ISSUED', 'DELIVERED', 'ACKNOWLEDGED', 'FILED', 'ARCHIVED'].includes(issued.status)) throw new DomainError('RESPONSE_DOCUMENT_NOT_ISSUED', 422, 'response_outgoing_id');
    }
    // Resolving late is allowed, and is recorded: how many working days after the deadline.
    const lateDays = letter.dueOn === null ? 0 : workingDaysLate(letter.dueOn, vietnamDateOf(now), await this.calendar(scope.tx, now, [letter.dueOn]));
    await this.incoming.markResolved(scope.tx, id, { expectedVersion: scope.expectedVersion ?? 0, summary: body.resolution_summary.trim(), responseOutgoingId: response, resolvedAt: now, lateDays, actor: scope.tenant.membershipId });
    const version = letter.version + 1;
    await this.written(scope, id, letter.documentId, 'RESOLVED', version, 'incoming_document.resolved', 'doc.incoming_resolved.v1', now, { from_status: letter.status, late_days: lateDays, response_outgoing_id: response ?? null, due_on: letter.dueOn });
    return { ...commandResult(scope, 'RESOLVED', version, id), late_days: lateDays };
  }

  @Post('incoming-documents/:id/rejection')
  @HttpCode(200)
  @OperationId('rejectIncomingDocument')
  @Command({ operation: 'rejectIncomingDocument', versioned: true })
  async reject(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['DocIncomingReject']): Promise<CommandResult> {
    const now = this.clock();
    const letter = await this.held(scope, id, incomingScope(access, REGISTER, now, scope.tenant.membershipId));
    assertIncomingTransition('reject', letter.status);
    if (body.rejection_reason.trim().length < 10) throw new DomainError('VALIDATION_FAILED', 422, 'rejection_reason');
    const duplicateOf = body.duplicate_of_id?.toLowerCase();
    if (duplicateOf !== undefined) {
      if (duplicateOf === letter.id || (letter.duplicateOfId !== null && duplicateOf !== letter.duplicateOfId)) throw new DomainError('VALIDATION_FAILED', 422, 'duplicate_of_id');
      if ((await this.incoming.find(scope.tx, duplicateOf, incomingScope(access, READ, now, scope.tenant.membershipId))) === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'duplicate_of_id');
    }
    await this.incoming.markRejected(scope.tx, id, { expectedVersion: scope.expectedVersion ?? 0, reason: body.rejection_reason.trim(), duplicateOfId: duplicateOf, actor: scope.tenant.membershipId });
    const version = letter.version + 1;
    await this.written(scope, id, letter.documentId, 'REJECTED', version, 'incoming_document.rejected', 'doc.incoming_rejected.v1', now, { from_status: letter.status, duplicate_of_id: duplicateOf ?? null }, body.rejection_reason.trim());
    return commandResult(scope, 'REJECTED', version, id);
  }

  /** The letter locked in the scope of the caller (a letter they cannot see does not exist), at the version they read. */
  private async held(scope: CommandScope, id: string, builder: ReturnType<typeof incomingScope>): Promise<IncomingRecord> {
    const letter = await this.incoming.lock(scope.tx, id, builder);
    if (letter === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (letter.version !== scope.expectedVersion) throw versionConflict(letter.version);
    return letter;
  }

  /** Only the handler works a letter (403 NOT_ASSIGNEE): the one it was given to, or, for a letter given to a unit with no one named, anyone who holds the right in that unit (not in the unit of the register, nor the one who took it in). */
  private async assertHandler(scope: CommandScope, access: EffectiveAccess, letter: IncomingRecord, now: Date): Promise<void> {
    if (letter.assigneeUserId === null) {
      const unit = letter.assignedUnitId === null || letter.assignedUnitPath === null ? undefined : { id: letter.assignedUnitId, path: letter.assignedUnitPath };
      if (unit === undefined || !mayActOnUnit(access, PROCESS, unit, now)) throw new DomainError('NOT_ASSIGNEE', 403);
      return;
    }
    const me = await this.incoming.userOf(scope.tx, scope.tenant.membershipId);
    if (me !== letter.assigneeUserId) throw new DomainError('NOT_ASSIGNEE', 403);
  }

  /** Whether the user, through any of their memberships, may work letters in the unit. */
  private async mayWork(tx: TenantTx, userId: string, unit: { id: string; path: string }, now: Date): Promise<boolean> {
    for (const membershipId of await this.incoming.membershipsOf(tx, userId)) {
      const access = await loadAccessIn(tx, membershipId);
      if (access.membershipActive && mayActOnUnit(access, PROCESS, unit, now)) return true;
    }
    return false;
  }

  private calendar(tx: TenantTx, now: Date, dueOns: ReadonlyArray<string | null>): Promise<WorkCalendarSource> {
    return calendarFor(this.calendars, tx, now, dueOns);
  }

  /** The audit row and the event of a step: ids, the states and the facts of the step; never the words of the letter. */
  private async written(scope: CommandScope, id: string, documentId: string, status: IncomingStatus, version: number, action: string, type: string, now: Date, facts: Record<string, unknown>, reason?: string): Promise<void> {
    await scope.audit({ action, resourceType: RESOURCE_TYPE, resourceId: id, classification: CLASSIFICATION, ...(reason === undefined ? {} : { reason }), diff: { to_status: status, ...facts } });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: id,
      aggregateVersion: version,
      type,
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, document_id: documentId, incoming_document_id: id, version, status, ...facts, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${RESOURCE_TYPE}:${id}:${version}`,
    });
  }
}

/** The incoming register in the scope of the caller (the right to read it is `doc.incoming.read`; the handler of a letter sees it too). */
@Controller()
export class IncomingReadsController {
  private readonly incoming = new DocIncomingStore();
  private readonly calendars = new WorkCalendarStore();
  private readonly clock: () => Date;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Optional() @Inject(DOC_CLOCK) clock?: () => Date,
  ) {
    this.clock = clock ?? ((): Date => new Date());
  }

  @Get('incoming-documents')
  @OperationId('listIncomingDocuments')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('status') status?: unknown,
    @Query('assigned_unit_id') assignedUnitId?: unknown,
    @Query('overdue') overdue?: unknown,
    @Query('year') year?: unknown,
    @Query('cursor') cursor?: unknown,
    @Query('limit') limit?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const statusValue = status === undefined ? undefined : INCOMING_STATUSES.find((candidate) => candidate === status);
    if (status !== undefined && statusValue === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'status');
    const unit = assignedUnitId === undefined ? undefined : typeof assignedUnitId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(assignedUnitId) ? assignedUnitId.toLowerCase() : undefined;
    if (assignedUnitId !== undefined && unit === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'assigned_unit_id');
    if (overdue !== undefined && overdue !== 'true' && overdue !== 'false') throw new DomainError('VALIDATION_FAILED', 422, 'overdue');
    if (year !== undefined && !(typeof year === 'string' && /^\d{4}$/.test(year))) throw new DomainError('VALIDATION_FAILED', 422, 'year');
    const page = parsePageRequest(limit, cursor);
    const now = this.clock();
    const found = await this.database.withTenant(tenant, async (tx) => {
      const result = await this.incoming.list(
        tx,
        { status: statusValue, assignedUnitId: unit, overdue: overdue === undefined ? undefined : overdue === 'true', year: year === undefined ? undefined : Number(year) },
        { limit: page.limit, after: page.after },
        incomingScope(access, READ, now, tenant.membershipId),
      );
      return { ...result, hidden: await hiddenLinks(this.incoming, tx, result.records, incomingScope(access, READ, now, tenant.membershipId)), me: await this.incoming.userOf(tx, tenant.membershipId), calendar: await calendarFor(this.calendars, tx, now, result.records.map((entry) => entry.dueOn)) };
    });
    return {
      items: found.records.map((record) => incomingView(record, { overdueDays: overdueDaysOf(record, now, found.calendar), actions: actionsOf(record, access, tenant.membershipId, now, found.me), hiddenLinks: found.hidden })),
      next_cursor: found.next === undefined ? null : encodeCursor(found.next),
      as_of: now.toISOString(),
    };
  }

  @Get('incoming-documents/:id')
  @OperationId('getIncomingDocument')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = this.clock();
    const found = await this.database.withTenant(tenant, async (tx) => {
      const record = await this.incoming.find(tx, id.toLowerCase(), incomingScope(access, READ, now, tenant.membershipId));
      if (record === undefined) return undefined;
      return { record, hidden: await hiddenLinks(this.incoming, tx, [record], incomingScope(access, READ, now, tenant.membershipId)), assignments: await this.incoming.assignments(tx, record.id), calendar: await calendarFor(this.calendars, tx, now, [record.dueOn]), me: await this.incoming.userOf(tx, tenant.membershipId) };
    });
    // A letter in another tenant or outside the scope of the caller is indistinguishable from one that does not exist.
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return incomingView(found.record, { overdueDays: overdueDaysOf(found.record, now, found.calendar), actions: actionsOf(found.record, access, tenant.membershipId, now, found.me), assignments: found.assignments, hiddenLinks: found.hidden });
  }
}

/** The letters that the records point to as their original and that the reader may not read. */
async function hiddenLinks(incoming: DocIncomingStore, tx: TenantTx, records: readonly IncomingRecord[], builder: ReturnType<typeof incomingScope>): Promise<Set<string>> {
  const hidden = new Set<string>();
  for (const id of new Set(records.flatMap((record) => (record.duplicateOfId === null ? [] : [record.duplicateOfId])))) {
    if ((await incoming.find(tx, id, builder)) === undefined) hidden.add(id);
  }
  return hidden;
}

/** The work calendar from the year of the oldest deadline (and the year before this one, for a deadline that is later): lateness counts from the deadline, so the years in between must be the published ones. */
export async function calendarFor(calendars: WorkCalendarStore, tx: TenantTx, now: Date, dueOns: ReadonlyArray<string | null>): Promise<WorkCalendarSource> {
  const years = dueOns.flatMap((due) => (due === null ? [] : [Number(due.slice(0, 4))]));
  const thisYear = Number(vietnamDateOf(now).slice(0, 4));
  // Every year from the deadline to the one after this: a deadline years back must not lose the holidays published for the years in between.
  return calendars.source(tx, INCOMING_CALENDAR, Math.min(thisYear - 1, ...years), thisYear + 1);
}

/** How many working days a letter that is being worked is past its deadline today, or none when it is not. */
function overdueDaysOf(record: IncomingRecord, now: Date, calendar: WorkCalendarSource): number | null {
  if (!isWorkable(record.status) || record.dueOn === null) return null;
  const days = workingDaysLate(record.dueOn, vietnamDateOf(now), calendar);
  return days > 0 ? days : null;
}

/** What the caller may do with the letter now, as buttons: the command applies to its state and the caller holds the right where the letter is. The server judges each command again. */
function actionsOf(record: IncomingRecord, access: EffectiveAccess, membershipId: string, now: Date, me?: string): Record<string, boolean> {
  const at = (unitId: string | null, path: string | null, permission: string): boolean => (unitId !== null && path !== null ? mayActOnUnit(access, permission, { id: unitId, path }, now) : false);
  const home = (permission: string): boolean => (record.registerId === null ? holdsAnywhere(access, permission, now) : at(record.homeUnitId, record.homeUnitPath, permission));
  // The handler by name must also hold the right to work letters through this membership (a read-only session or a revoked right shows no button).
  const handler = record.assigneeUserId === null ? at(record.assignedUnitId, record.assignedUnitPath, PROCESS) : me !== undefined && me === record.assigneeUserId && holdsAnywhere(access, PROCESS, now);
  void membershipId;
  return {
    register: record.status === 'RECEIVED' && home(REGISTER),
    reject: record.status === 'RECEIVED' && home(REGISTER),
    assign: (record.status === 'REGISTERED' || record.status === 'ASSIGNED' || record.status === 'PROCESSING') && (home(ASSIGN) || at(record.assignedUnitId, record.assignedUnitPath, ASSIGN)),
    startProcessing: record.status === 'ASSIGNED' && handler,
    resolve: record.status === 'PROCESSING' && handler,
  };
}
