import { citationRefOf } from '@machvon/kernel';
import type { CommentRow, DocumentHeader, ReviewEventRow, ReviewRow, UnitRow, VersionHeader } from '@machvon/db';

/** The shapes the repository answers with (DOC-2): what a screen needs and nothing of where a file is kept (the object key never leaves the server). */

export type Names = ReadonlyMap<string, string>;

const nameOf = (names: Names, id: string | null): string | null => (id === null ? null : (names.get(id) ?? null));

export function documentDto(document: DocumentHeader): Record<string, unknown> {
  return {
    id: document.id,
    project: document.project,
    contract: document.contract,
    package: document.package,
    doc_class: document.docClass,
    title: document.title,
    reference: document.reference,
    security_class: document.securityClass,
    effective_from: document.effectiveFrom,
    effective_to: document.effectiveTo,
    effective_state: document.effectiveState,
    note: document.note,
    status: document.status,
    archive_reason: document.archiveReason,
    current_version: document.currentVersion === null ? null : { id: document.currentVersion.id, version_no: document.currentVersion.versionNo, status: document.currentVersion.status, format: document.currentVersion.format },
    approved_version: document.approvedVersion === null ? null : { id: document.approvedVersion.id, version_no: document.approvedVersion.versionNo },
    version_count: document.versionCount,
    latest_review: document.latestReview,
    version: document.version,
    created_at: document.createdAt,
    created_by: document.createdBy,
    updated_at: document.updatedAt,
    updated_by: document.updatedBy,
  };
}

export function versionDto(version: VersionHeader, names: Names, openComments: number): Record<string, unknown> {
  return {
    id: version.id,
    document_id: version.documentId,
    version_no: version.versionNo,
    file_sha256: version.fileSha256,
    size_bytes: version.sizeBytes,
    format: version.format,
    page_count: version.pageCount,
    extraction_status: version.extractionStatus,
    extraction_engine: version.extractionEngine,
    unit_count: version.unitCount,
    truncated_units: version.truncatedUnits,
    status: version.status,
    change_note: version.changeNote,
    locked: version.locked,
    locked_at: version.lockedAt,
    locked_by_name: nameOf(names, version.lockedBy),
    open_comments: openComments,
    created_at: version.createdAt,
    created_by_name: nameOf(names, version.createdBy),
  };
}

export function reviewRoundDto(review: ReviewRow): Record<string, unknown> {
  return {
    id: review.id,
    document_id: review.documentId,
    version_id: review.versionId,
    version_no: review.versionNo,
    round: review.round,
    previous_review_id: review.previousReviewId,
    status: review.status,
    submitted_by_name: review.submittedByName,
    submitted_at: review.submittedAt,
    submit_note: review.submitNote,
    concluded_at: review.concludedAt,
    conclusion_note: review.conclusionNote,
    version: review.version,
  };
}

export function unitDto(unit: UnitRow, versionId: string): Record<string, unknown> {
  return {
    id: unit.id,
    seq: unit.seq,
    citation_id: unit.citationId,
    citation_ref: citationRefOf(versionId, unit.citationId),
    kind: unit.kind,
    locator: unit.locatorKey,
    label: unit.label,
    page: unit.page,
    paragraph: unit.paragraph,
    sheet: unit.sheet,
    cell: unit.cell,
    box: unit.box,
    text: unit.text,
    text_sha256: unit.textSha256,
    confidence: unit.confidence,
    open_comments: unit.openComments,
  };
}

export function commentDto(comment: CommentRow): Record<string, unknown> {
  return {
    id: comment.id,
    version_id: comment.versionId,
    citation_id: comment.citationId,
    citation_label: comment.citationLabel,
    parent_id: comment.parentId,
    review_id: comment.reviewId,
    body: comment.body,
    author_name: comment.authorName,
    author_id: comment.authorId,
    status: comment.status,
    resolved_by: comment.resolvedBy,
    resolved_at: comment.resolvedAt,
    resolution_note: comment.resolutionNote,
    created_at: comment.createdAt,
  };
}

export function eventDto(event: ReviewEventRow): Record<string, unknown> {
  return { seq: event.seq, kind: event.kind, actor_name: event.actorName, occurred_at: event.occurredAt, detail: event.detail };
}
