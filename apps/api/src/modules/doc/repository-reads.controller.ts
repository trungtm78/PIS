import { randomUUID } from 'node:crypto';
import { Controller, Get, Header, Inject, Param, ParseUUIDPipe, Query, StreamableFile } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { AuditWriter, DocumentCommentStore, DocumentRepositoryStore, DocumentReviewStore, DocumentTextStore, TenantDatabase, projectScope } from '@machvon/db';
import {
  CITATION_ID,
  DOCUMENT_CLASSES,
  DOCUMENT_REVIEW_STATUSES,
  DomainError,
  citationRefOf,
  compareUnits,
  objectKey,
  parseObjectKey,
} from '@machvon/kernel';
import type { CompareEntry, CompareUnit, EffectiveAccess, EffectiveState, TenantContext } from '@machvon/kernel';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { Public } from '../../public.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { FileService } from '../files';
import { commentDto, documentDto, reviewRoundDto, unitDto, versionDto } from './repository-view';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIGNATURE = /^[0-9a-f]{64}$/;
const LINK_TTL_SECONDS = 300;
const FILE_KIND = 'document';
const EFFECTIVE_STATES: readonly EffectiveState[] = ['UNDATED', 'NOT_YET', 'IN_FORCE', 'EXPIRED'];
const VERSION_RESOURCE = 'project_document_version';

/** What the comparison counts and how, so that a number on the screen has its formula (DOC-27). */
export const COMPARE_FORMULA =
  'Units are lined up by a longest common subsequence of their SHA-256 digests; a removed and an added unit between two equal ones are one changed unit when they share at least 40 percent of their words; the words of a changed unit are diffed the same way. A workbook is compared cell by cell by sheet and address.';

function text(value: unknown, field: string, max = 100): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) throw new DomainError('VALIDATION_FAILED', 422, field);
  return value.trim();
}

function uuidQuery(value: unknown, field: string): string | undefined {
  const given = text(value, field, 36);
  if (given !== undefined && !UUID.test(given)) throw new DomainError('VALIDATION_FAILED', 422, field);
  return given?.toLowerCase();
}

function oneOf<T extends string>(value: unknown, field: string, allowed: readonly T[]): T | undefined {
  const given = text(value, field, 40);
  if (given === undefined) return undefined;
  const found = allowed.find((candidate) => candidate === given);
  if (found === undefined) throw new DomainError('VALIDATION_FAILED', 422, field);
  return found;
}

const compareRef = (unit: CompareUnit | null): Record<string, unknown> | null => (unit === null ? null : { citation_id: unit.citationId, label: unit.label, kind: unit.kind, text: unit.text, seq: unit.seq });
const compareEntryDto = (entry: CompareEntry): Record<string, unknown> => ({ op: entry.op, before: compareRef(entry.before), after: compareRef(entry.after), words: entry.words });

/**
 * The reads of the project document repository (DOC-24, DOC-25, DOC-27). A document is seen in the scope of the caller over its project, or it does not exist for them (404); a read never writes, except the row of the
 * trail that opening the text of a confidential or personal file and downloading any file leave. A response carries no object key: the link of a download is a signed one that lives five minutes.
 */
@Controller()
export class ProjectDocumentReadsController {
  private readonly store = new DocumentRepositoryStore();
  private readonly texts = new DocumentTextStore();
  private readonly comments = new DocumentCommentStore();
  private readonly reviews = new DocumentReviewStore();
  private readonly audit: AuditWriter;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Inject(FileService) private readonly files: FileService,
  ) {
    this.audit = new AuditWriter(database);
  }

  @Get('project-documents')
  @OperationId('listProjectDocuments')
  async list(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const now = new Date();
    const request = parsePageRequest(query.limit, query.cursor);
    const filter = {
      projectId: uuidQuery(query.project_id, 'project_id'),
      contractId: uuidQuery(query.contract_id, 'contract_id'),
      packageId: uuidQuery(query.package_id, 'package_id'),
      docClass: oneOf(query.doc_class, 'doc_class', DOCUMENT_CLASSES),
      status: oneOf(query.status, 'status', ['ACTIVE', 'ARCHIVED'] as const),
      effective: oneOf(query.effective, 'effective', EFFECTIVE_STATES),
      reviewStatus: oneOf(query.review_status, 'review_status', [...DOCUMENT_REVIEW_STATUSES, 'NONE'] as const),
      q: text(query.q, 'q'),
    };
    const page = await this.database.withTenant(tenant, (tx) =>
      this.store.list(tx, filter, projectScope(access, PERMISSIONS.listProjectDocuments, now), now, { limit: request.limit, after: request.after === undefined ? undefined : { key: request.after.code, id: request.after.id } }),
    );
    return {
      items: page.items.map(documentDto),
      next_cursor: page.more && page.last !== undefined ? encodeCursor({ code: page.last.key, id: page.last.id }) : null,
      classes: [...DOCUMENT_CLASSES],
      as_of: now.toISOString(),
    };
  }

  @Get('project-documents/:id')
  @OperationId('getProjectDocument')
  async detail(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = new Date();
    return this.database.withTenant(tenant, async (tx) => {
      const document = await this.store.find(tx, id.toLowerCase(), projectScope(access, PERMISSIONS.getProjectDocument, now), now);
      if (document === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      const versions = await this.store.versionsOf(tx, document.id);
      const rounds = await this.reviews.roundsOf(tx, document.id);
      const open = await this.comments.openCounts(tx, document.id);
      const names = await this.store.names(tx, [...versions.flatMap((version) => [version.createdBy, version.lockedBy]), ...rounds.map((round) => round.submittedBy)]);
      const can = async (permission: string): Promise<boolean> => (await this.store.find(tx, document.id, projectScope(access, permission, now), now)) !== undefined;
      const [upload, comment, submit] = [await can(PERMISSIONS.addProjectDocumentVersion), await can(PERMISSIONS.addDocumentComment), await can(PERMISSIONS.submitDocumentForReview)];
      const active = document.status === 'ACTIVE';
      const latest = rounds[0];
      const draft = document.currentVersion?.status === 'DRAFT';
      return {
        document: documentDto(document),
        versions: versions.map((version) => versionDto(version, names, open.get(version.id) ?? 0)),
        rounds: rounds.map(reviewRoundDto),
        actions: {
          update: upload && active,
          add_version: upload && active,
          archive: upload && active && latest?.status !== 'IN_REVIEW',
          restore: upload && !active,
          comment,
          submit_for_review: submit && active && draft && latest?.status !== 'IN_REVIEW',
          withdraw_review: submit && latest?.status === 'IN_REVIEW' && latest.submittedBy === tenant.membershipId,
        },
        as_of: now.toISOString(),
      };
    });
  }

  @Get('project-document-versions/:id')
  @OperationId('getProjectDocumentVersion')
  async version(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = new Date();
    return this.database.withTenant(tenant, async (tx) => {
      const found = await this.store.findVersion(tx, id.toLowerCase(), projectScope(access, PERMISSIONS.getProjectDocumentVersion, now), now);
      if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      const open = await this.comments.openCounts(tx, found.document.id);
      const names = await this.store.names(tx, [found.version.createdBy, found.version.lockedBy]);
      const outline = await this.texts.outline(tx, found.version.id);
      const first = await this.texts.list(tx, found.version.id, {}, { limit: 1, afterSeq: undefined });
      const can = async (permission: string): Promise<boolean> => (await this.store.find(tx, found.document.id, projectScope(access, permission, now), now)) !== undefined;
      const unfinished = found.version.extractionStatus !== 'EXTRACTED' && !found.version.locked;
      return {
        version: versionDto(found.version, names, open.get(found.version.id) ?? 0),
        document: documentDto(found.document),
        outline,
        citation_example: first.items[0] === undefined ? null : citationRefOf(found.version.id, first.items[0].citationId),
        actions: { comment: await can(PERMISSIONS.addDocumentComment), re_extract: unfinished && (await can(PERMISSIONS.rerunDocumentExtraction)), download: await can(PERMISSIONS.getProjectDocumentVersionDownload) },
        as_of: now.toISOString(),
      };
    });
  }

  @Get('project-document-versions/:id/units')
  @OperationId('listDocumentTextUnits')
  async units(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const now = new Date();
    const request = parsePageRequest(query.limit, query.cursor);
    const pageText = text(query.page, 'page', 7);
    if (pageText !== undefined && !/^[1-9]\d{0,5}$/.test(pageText)) throw new DomainError('VALIDATION_FAILED', 422, 'page');
    const filter = { page: pageText === undefined ? undefined : Number(pageText), sheet: text(query.sheet, 'sheet', 31), q: text(query.q, 'q') };
    let afterSeq: number | undefined;
    if (request.after !== undefined) {
      afterSeq = Number(request.after.code);
      if (!Number.isInteger(afterSeq) || afterSeq < 0) throw new DomainError('VALIDATION_FAILED', 422, 'cursor');
    }
    return this.database.withTenant(tenant, async (tx) => {
      const found = await this.store.findVersion(tx, id.toLowerCase(), projectScope(access, PERMISSIONS.listDocumentTextUnits, now), now);
      if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      const page = await this.texts.list(tx, found.version.id, filter, { limit: request.limit, afterSeq });
      const last = page.items[page.items.length - 1];
      // Opening the text of a confidential or personal file is recorded: who, which version, how many units; never the text.
      if (afterSeq === undefined && (found.document.securityClass === 'CONFIDENTIAL' || found.document.securityClass === 'PERSONAL')) {
        await this.audit.recordInTx(tx, tenant.membershipId, {
          action: 'doc.repo.text_opened',
          resourceType: VERSION_RESOURCE,
          resourceId: found.version.id,
          classification: 'CONFIDENTIAL',
          diff: { document_id: found.document.id, version_no: found.version.versionNo, units: page.items.length, filtered: filter.q !== undefined },
          correlationId: randomUUID(),
          requestId: randomUUID(),
        });
      }
      return { items: page.items.map((unit) => unitDto(unit, found.version.id)), next_cursor: page.more && last !== undefined ? encodeCursor({ code: String(last.seq), id: last.id }) : null, as_of: now.toISOString() };
    });
  }

  @Get('project-document-versions/:id/units/:citationId')
  @OperationId('resolveDocumentCitation')
  async citation(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Param('citationId') citationId: string): Promise<Record<string, unknown>> {
    const now = new Date();
    if (!CITATION_ID.test(citationId)) throw new DomainError('VALIDATION_FAILED', 422, 'citation_id');
    return this.database.withTenant(tenant, async (tx) => {
      const found = await this.store.findVersion(tx, id.toLowerCase(), projectScope(access, PERMISSIONS.resolveDocumentCitation, now), now);
      if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      const resolved = await this.texts.resolve(tx, found.version.id, citationId);
      if (resolved === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      const { document, version } = found;
      return {
        citation_ref: citationRefOf(version.id, citationId),
        document: { id: document.id, title: document.title, reference: document.reference, doc_class: document.docClass, project: document.project },
        version: { id: version.id, version_no: version.versionNo, status: version.status, locked: version.locked, file_sha256: version.fileSha256 },
        unit: unitDto(resolved.unit, version.id),
        before: resolved.before === null ? null : unitDto(resolved.before, version.id),
        after: resolved.after === null ? null : unitDto(resolved.after, version.id),
        as_of: now.toISOString(),
      };
    });
  }

  @Get('project-document-versions/:id/comments')
  @OperationId('listDocumentComments')
  async commentList(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const now = new Date();
    const citationId = text(query.citation_id, 'citation_id', 40);
    if (citationId !== undefined && !CITATION_ID.test(citationId)) throw new DomainError('VALIDATION_FAILED', 422, 'citation_id');
    const status = oneOf(query.status, 'status', ['OPEN', 'RESOLVED'] as const);
    return this.database.withTenant(tenant, async (tx) => {
      const found = await this.store.findVersion(tx, id.toLowerCase(), projectScope(access, PERMISSIONS.listDocumentComments, now), now);
      if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      const items = await this.comments.list(tx, found.version.id, { citationId, status });
      return { items: items.map(commentDto), open_count: items.filter((item) => item.status === 'OPEN').length, as_of: now.toISOString() };
    });
  }

  @Get('project-documents/:id/compare')
  @OperationId('compareDocumentVersions')
  async compare(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const now = new Date();
    const fromId = uuidQuery(query.from_version_id, 'from_version_id');
    const toId = uuidQuery(query.to_version_id, 'to_version_id');
    if (fromId === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'from_version_id');
    if (toId === undefined || toId === fromId) throw new DomainError('VALIDATION_FAILED', 422, 'to_version_id');
    return this.database.withTenant(tenant, async (tx) => {
      const scope = projectScope(access, PERMISSIONS.compareDocumentVersions, now);
      const [from, to] = [await this.store.findVersion(tx, fromId, scope, now), await this.store.findVersion(tx, toId, scope, now)];
      if (from === undefined || to === undefined || from.document.id !== id.toLowerCase() || to.document.id !== id.toLowerCase()) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      const result = compareUnits(await this.texts.forCompare(tx, fromId), await this.texts.forCompare(tx, toId));
      const refOf = (found: typeof from): Record<string, unknown> => ({ id: found.version.id, version_no: found.version.versionNo, status: found.version.status, locked: found.version.locked });
      return { document_id: id.toLowerCase(), from: refOf(from), to: refOf(to), mode: result.mode, summary: result.summary, entries: result.entries.map(compareEntryDto), formula: COMPARE_FORMULA, as_of: now.toISOString() };
    });
  }

  @Get('project-document-versions/:id/download')
  @OperationId('getProjectDocumentVersionDownload')
  async download(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = new Date();
    const found = await this.database.withTenant(tenant, (tx) => this.store.findVersion(tx, id.toLowerCase(), projectScope(access, PERMISSIONS.getProjectDocumentVersionDownload, now), now));
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const grant = await this.files.presignDownload(tenant, found.version.fileObjectKey, LINK_TTL_SECONDS);
    const fileId = parseObjectKey(found.version.fileObjectKey)?.id;
    if (fileId === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    await this.database.withTenant(tenant, (tx) =>
      this.audit.recordInTx(tx, tenant.membershipId, {
        action: 'doc.repo.file_downloaded',
        resourceType: VERSION_RESOURCE,
        resourceId: found.version.id,
        classification: 'CONFIDENTIAL',
        diff: { document_id: found.document.id, version_no: found.version.versionNo, file_sha256: found.version.fileSha256, expires_at: new Date(grant.expires * 1000).toISOString() },
        correlationId: randomUUID(),
        requestId: randomUUID(),
      }),
    );
    const query = new URLSearchParams({ tenant: tenant.tenantId, expires: String(grant.expires), signature: grant.signature });
    return { version_id: found.version.id, url: `/project-document-files/${fileId}?${query.toString()}`, expires_at: new Date(grant.expires * 1000).toISOString(), mime: found.version.mime, file_sha256: found.version.fileSha256, size_bytes: found.version.sizeBytes, page_count: found.version.pageCount };
  }

  /**
   * The signed link of a download: it serves the bytes while the signature is good and the time has not run out, and nothing else (a forged, altered, expired or foreign link all answer the same 401
   * `SIGNATURE_INVALID`). The link is made by `getProjectDocumentVersionDownload` after the scope of the caller over the project was judged.
   */
  @Public()
  @Header('Cache-Control', 'private, no-store')
  @Get('project-document-files/:fileId')
  async file(@Param('fileId') fileId: string, @Query('tenant') tenantId: unknown, @Query('expires') expires: unknown, @Query('signature') signature: unknown): Promise<StreamableFile> {
    const invalid = (): DomainError => new DomainError('SIGNATURE_INVALID', 401);
    if (typeof tenantId !== 'string' || typeof expires !== 'string' || typeof signature !== 'string' || !UUID.test(tenantId) || !SIGNATURE.test(signature) || !/^[0-9]{1,12}$/.test(expires)) throw invalid();
    if (!UUID.test(fileId)) throw invalid();
    const key = objectKey(tenantId.toLowerCase(), FILE_KIND, fileId.toLowerCase());
    const { object, bytes } = await this.files.redeemDownload({ method: 'GET', key, expires: Number(expires), signature }).catch((error: unknown) => {
      throw error instanceof DomainError ? error : invalid();
    });
    return new StreamableFile(bytes, { type: object.contentType, disposition: `attachment; filename="project-document-${fileId.toLowerCase()}"`, length: bytes.length });
  }
}

