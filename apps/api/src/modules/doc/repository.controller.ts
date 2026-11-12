import { Body, Controller, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { DocumentRepositoryStore, PublicProjectDocumentExtension, projectScope } from '@machvon/db';
import type { ExtractionRecord, LegalDocTypeChange, ProjectDocumentExtension } from '@machvon/db';
import { DomainError, projectDocumentChangeOf, projectDocumentInputOf, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { DocumentFileUploadGuard, UploadedBytes } from '../sas/theme-assets';
import type { UploadedFile } from '../sas/theme-assets';
import { pageCountOf } from './external-signature';
import { RepositoryFiles } from './repository-files';
import { PROJECT_DOCUMENT_EXTENSION } from './tokens';

const DOCUMENT_RESOURCE = 'project_document';
const VERSION_RESOURCE = 'project_document_version';

const idOf = (value: string): string => value.toLowerCase();

/** The classification a trail row of a document carries: the one the document has, so a confidential file leaves confidential rows. */
const classificationOf = (securityClass: string): 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' => (securityClass === 'PUBLIC' ? 'PUBLIC' : securityClass === 'INTERNAL' ? 'INTERNAL' : 'CONFIDENTIAL');

const noteOf = (value: unknown, field: string): string | null => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 2000) throw new DomainError('VALIDATION_FAILED', 422, field);
  return value.trim();
};

/** The pages of a PDF, or none when the reader cannot open it (the version is still kept; its text will say it could not be read). */
async function pageCountOrNull(bytes: Uint8Array): Promise<number | null> {
  try {
    return await pageCountOf(bytes);
  } catch (error) {
    if (error instanceof DomainError) return null;
    throw error;
  }
}

/**
 * The upload of a file of the project repository (DOC-24, PD.01): a PDF, a Word file or a workbook, judged by its bytes, scanned and stored under the tenant. Nothing is attached to a document yet; the key and the hash it answers are
 * what `createProjectDocument` and `addProjectDocumentVersion` take, and those open the file again and check it.
 */
@Controller()
export class ProjectDocumentFilesController {
  constructor(@Inject(RepositoryFiles) private readonly repositoryFiles: RepositoryFiles) {}

  @Post('project-documents/files')
  @HttpCode(200)
  @UseGuards(DocumentFileUploadGuard)
  @OperationId('uploadProjectDocumentFile')
  @Command({ operation: 'uploadProjectDocumentFile' })
  async upload(@Scope() scope: CommandScope, @UploadedBytes() file: UploadedFile): Promise<Schemas['ProjectDocumentFileUpload']> {
    const staged = await this.repositoryFiles.stage(scope.tenant, { declaredType: file.contentType, bytes: file.bytes });
    const pages = staged.format === 'PDF' ? await pageCountOrNull(file.bytes) : null;
    await scope.audit({
      action: 'doc.repo.file_uploaded',
      resourceType: VERSION_RESOURCE,
      resourceId: scope.tenant.tenantId,
      classification: 'CONFIDENTIAL',
      diff: { file_sha256: staged.sha256, size_bytes: file.bytes.length, format: staged.format, page_count: pages },
    });
    return { file_object_key: staged.key, file_sha256: staged.sha256, size_bytes: file.bytes.length, format: staged.format, mime: staged.mime, page_count: pages };
  }
}

/**
 * The commands on the documents of a project and their versions (DOC-24, DOC-25, PD.01, PD.02). A project is in the scope of the caller or it does not exist for them (404). The rules are the kernel's and the
 * database's (docs/doc-repository.md); a version that is approved is locked and no command here reaches it. Every command writes its audit row and its event in its own transaction, and none of them carries the
 * title, the text or the key of a file.
 */
@Controller()
export class ProjectDocumentsController {
  private readonly store = new DocumentRepositoryStore();
  private readonly extension: ProjectDocumentExtension;

  constructor(
    @Inject(RepositoryFiles) private readonly repositoryFiles: RepositoryFiles,
    // What the edition adds to a document (the legal-document type of the enterprise edition); the public edition binds none and refuses the member.
    @Optional() @Inject(PROJECT_DOCUMENT_EXTENSION) extension?: ProjectDocumentExtension,
  ) {
    this.extension = extension ?? new PublicProjectDocumentExtension();
  }

  @Post('project-documents')
  @HttpCode(200)
  @OperationId('createProjectDocument')
  @Command({ operation: 'createProjectDocument' })
  async create(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['ProjectDocumentCreate']): Promise<CommandResult> {
    const now = new Date();
    const input = projectDocumentInputOf(body as unknown as Record<string, unknown>);
    const changeNote = noteOf(body.change_note, 'change_note');
    // The edition judges the legal type before the file is opened and before anything is written.
    const legal = await this.extension.legalDocType(scope.tx, (body as Record<string, unknown>).legal_doc_type, vietnamDateOf(now));
    const opened = await this.repositoryFiles.open(scope.tenant, body.file_object_key, body.file_sha256);
    const { record, facts } = await this.repositoryFiles.read(opened);
    const { document, version } = await this.store.create(scope.tx, input, facts, record, changeNote, scope.tenant.membershipId, projectScope(access, PERMISSIONS.createProjectDocument, now), now);
    await this.written(scope, 'doc.repo.document_created', document.id, document.securityClass, document.version, {
      project_id: document.project.id,
      contract_id: document.contract?.id ?? null,
      package_id: document.package?.id ?? null,
      doc_class: document.docClass,
      security_class: document.securityClass,
      effective_from: document.effectiveFrom,
      effective_to: document.effectiveTo,
    }, now);
    await this.versionWritten(scope, document.id, document.project.id, document.securityClass, version.id, version.versionNo, version.fileSha256, version.extractionStatus, record, now);
    await this.legalTypeRecorded(scope, document.id, document.project.id, document.securityClass, legal);
    return commandResult(scope, 'CREATED', document.version, document.id);
  }

  @Post('project-documents/:id/description')
  @HttpCode(200)
  @OperationId('updateProjectDocument')
  @Command({ operation: 'updateProjectDocument', versioned: true })
  async update(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['ProjectDocumentUpdate']): Promise<CommandResult> {
    const now = new Date();
    const documentScope = projectScope(access, PERMISSIONS.updateProjectDocument, now);
    const current = await this.store.find(scope.tx, idOf(id), documentScope, now);
    if (current === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const { legal_doc_type: legalRaw, ...described } = body as unknown as Record<string, unknown>;
    const legal = await this.extension.legalDocType(scope.tx, legalRaw, vietnamDateOf(now));
    // A change that names the legal type alone still moves the version of the document (the type is part of what the document says it is): the note is written back as it stands.
    const change = legal.set && Object.keys(described).length === 0 ? { note: current.note } : projectDocumentChangeOf(described, current);
    const done = await this.store.update(scope.tx, idOf(id), scope.expectedVersion ?? 0, change, scope.tenant.membershipId, documentScope, now);
    await this.legalTypeRecorded(scope, id, done.after.project.id, done.after.securityClass, legal);
    // The trail says which members changed and from what to what for the fields that are not free text; the title and the note are named, never copied.
    const fields = Object.keys(described).length === 0 ? [] : Object.keys(change).map((key) => key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`));
    if (legal.set) fields.push('legal_doc_type');
    await this.written(scope, 'doc.repo.document_updated', id, done.after.securityClass, done.after.version, {
      project_id: done.after.project.id,
      fields,
      doc_class: { from: done.before.docClass, to: done.after.docClass },
      security_class: { from: done.before.securityClass, to: done.after.securityClass },
      effective_from: { from: done.before.effectiveFrom, to: done.after.effectiveFrom },
      effective_to: { from: done.before.effectiveTo, to: done.after.effectiveTo },
      contract_id: { from: done.before.contract?.id ?? null, to: done.after.contract?.id ?? null },
      package_id: { from: done.before.package?.id ?? null, to: done.after.package?.id ?? null },
    }, now);
    return commandResult(scope, 'UPDATED', done.after.version, done.after.id);
  }

  @Post('project-documents/:id/versions')
  @HttpCode(200)
  @OperationId('addProjectDocumentVersion')
  @Command({ operation: 'addProjectDocumentVersion' })
  async addVersion(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['ProjectDocumentVersionCreate']): Promise<CommandResult> {
    const now = new Date();
    const documentScope = projectScope(access, PERMISSIONS.addProjectDocumentVersion, now);
    // The document comes first: one that is not in this tenant, or whose project is out of the scope, is 404 whatever the body says, so a refusal of the note or of the file never tells that an id of another tenant exists.
    if ((await this.store.find(scope.tx, idOf(id), documentScope, now)) === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const changeNote = noteOf(body.change_note, 'change_note');
    const opened = await this.repositoryFiles.open(scope.tenant, body.file_object_key, body.file_sha256);
    const { record, facts } = await this.repositoryFiles.read(opened);
    const { document, version } = await this.store.addVersion(scope.tx, idOf(id), facts, record, changeNote, scope.tenant.membershipId, documentScope, now);
    await this.versionWritten(scope, document.id, document.project.id, document.securityClass, version.id, version.versionNo, version.fileSha256, version.extractionStatus, record, now);
    return commandResult(scope, 'VERSION_ADDED', version.versionNo, version.id);
  }

  @Post('project-documents/:id/archive')
  @HttpCode(200)
  @OperationId('archiveProjectDocument')
  @Command({ operation: 'archiveProjectDocument', versioned: true })
  async archive(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['ProjectDocumentArchive']): Promise<CommandResult> {
    const now = new Date();
    if (typeof body.reason !== 'string' || body.reason.trim().length < 10 || body.reason.length > 2000) throw new DomainError('VALIDATION_FAILED', 422, 'reason');
    const done = await this.store.setArchived(scope.tx, idOf(id), scope.expectedVersion ?? 0, { reason: body.reason.trim() }, scope.tenant.membershipId, projectScope(access, PERMISSIONS.archiveProjectDocument, now), now);
    await this.written(scope, 'doc.repo.document_archived', id, done.after.securityClass, done.after.version, { project_id: done.after.project.id, has_reason: true }, now, body.reason.trim());
    return commandResult(scope, 'ARCHIVED', done.after.version, done.after.id);
  }

  @Post('project-documents/:id/restore')
  @HttpCode(200)
  @OperationId('restoreProjectDocument')
  @Command({ operation: 'restoreProjectDocument', versioned: true })
  async restore(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    const now = new Date();
    const done = await this.store.setArchived(scope.tx, idOf(id), scope.expectedVersion ?? 0, null, scope.tenant.membershipId, projectScope(access, PERMISSIONS.restoreProjectDocument, now), now);
    await this.written(scope, 'doc.repo.document_restored', id, done.after.securityClass, done.after.version, { project_id: done.after.project.id }, now);
    return commandResult(scope, 'RESTORED', done.after.version, done.after.id);
  }

  @Post('project-document-versions/:id/extraction')
  @HttpCode(200)
  @OperationId('rerunDocumentExtraction')
  @Command({ operation: 'rerunDocumentExtraction' })
  async rerun(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    const now = new Date();
    const documentScope = projectScope(access, PERMISSIONS.rerunDocumentExtraction, now);
    const found = await this.store.findVersion(scope.tx, idOf(id), documentScope, now);
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    // The file is opened again from the store under the hash it was kept with: a file that changed underneath is refused, never read.
    const opened = await this.repositoryFiles.open(scope.tenant, found.version.fileObjectKey, found.version.fileSha256);
    const { record } = await this.repositoryFiles.read(opened);
    const done = await this.store.reextract(scope.tx, idOf(id), record, documentScope, now);
    await this.versionWritten(scope, done.document.id, done.document.project.id, done.document.securityClass, done.after.id, done.after.versionNo, done.after.fileSha256, done.after.extractionStatus, record, now, 'doc.repo.version_extracted');
    return commandResult(scope, done.after.extractionStatus, done.after.versionNo, done.after.id);
  }

  /** Keeps the legal type the request named and says so in the trail; nothing happens for a request that did not name one (the public edition always). */
  private async legalTypeRecorded(scope: CommandScope, documentId: string, projectId: string, securityClass: string, legal: LegalDocTypeChange): Promise<void> {
    if (!legal.set) return;
    const moved = await this.extension.recordLegalDocType(scope.tx, documentId, legal.code, scope.tenant.membershipId);
    if (moved.from === moved.to) return;
    await scope.audit({ action: 'doc.repo.document_legal_type_set', resourceType: DOCUMENT_RESOURCE, resourceId: documentId, classification: classificationOf(securityClass), diff: { project_id: projectId, legal_doc_type: { from: moved.from, to: moved.to } } });
  }

  private async written(scope: CommandScope, action: string, id: string, securityClass: string, version: number, diff: Record<string, unknown>, now: Date, reason?: string): Promise<void> {
    await scope.audit({ action, resourceType: DOCUMENT_RESOURCE, resourceId: id, classification: classificationOf(securityClass), diff, ...(reason === undefined ? {} : { reason }) });
    await scope.emit({
      aggregateType: DOCUMENT_RESOURCE,
      aggregateId: id,
      aggregateVersion: version,
      type: `${action}.v1`,
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, document_id: id, ...(typeof diff.project_id === 'string' ? { project_id: diff.project_id } : {}), version, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${DOCUMENT_RESOURCE}:${id}:${action}:${version}`,
    });
  }

  private async versionWritten(
    scope: CommandScope,
    documentId: string,
    projectId: string,
    securityClass: string,
    versionId: string,
    versionNo: number,
    sha256: string,
    extractionStatus: string,
    record: ExtractionRecord,
    now: Date,
    action = 'doc.repo.version_added',
  ): Promise<void> {
    await scope.audit({
      action,
      resourceType: VERSION_RESOURCE,
      resourceId: versionId,
      classification: classificationOf(securityClass),
      diff: { document_id: documentId, project_id: projectId, version_no: versionNo, file_sha256: sha256, extraction_status: extractionStatus, unit_count: record.units.length, truncated_units: record.truncated, engine: record.engine === null ? null : `${record.engine.name} ${record.engine.version}` },
    });
    await scope.emit({
      aggregateType: VERSION_RESOURCE,
      aggregateId: versionId,
      aggregateVersion: 1,
      type: `${action}.v1`,
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, document_id: documentId, project_id: projectId, version_id: versionId, version_no: versionNo, file_sha256: sha256, extraction_status: extractionStatus, unit_count: record.units.length, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${VERSION_RESOURCE}:${versionId}:${action}`,
    });
  }
}
