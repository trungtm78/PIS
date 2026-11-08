import type { EgpHealthReading, EgpMappingRow, EgpRunRow, QuarantinedRow } from '@machvon/db';
import { EGP_LAYOUT_KINDS, EGP_PENDING_EXTERNAL_ITEMS, egpAcceptance, egpHeaderOf, egpLayoutColumns } from '@machvon/kernel';
import type { EgpLayoutKind } from '@machvon/kernel';

/** The words of the formula behind a suggestion: shown beside the number on BID-23. */
export const SUGGESTION_FORMULA = 'Độ giống = số từ chung của hai tên (bỏ dấu, không phân biệt hoa thường) chia số từ của hợp của hai tên (chỉ số Jaccard); chỉ gợi ý khi giá bằng nhau đến đơn vị và độ giống đạt ngưỡng.';
export const SUGGESTION_SOURCE = 'Ngưỡng EGP_SUGGESTION_THRESHOLD do nhóm phát triển đặt (EGP-1), chưa có văn bản hay đơn vị vận hành xác nhận; là gợi ý để người xác nhận, không bao giờ tự nối.';

const nameOf = (names: ReadonlyMap<string, string>, id: string | null): string | null => (id === null ? null : (names.get(id) ?? null));

export function runDto(row: EgpRunRow, names: ReadonlyMap<string, string>): Record<string, unknown> {
  return {
    id: row.id,
    kind: row.kind,
    connector_code: row.connectorCode,
    layout_version: row.layoutVersion,
    acceptance: egpAcceptance(row.layoutVersion),
    file_sha256: row.fileSha256,
    status: row.status,
    error_code: row.errorCode,
    counts: {
      total: row.counts.total,
      applied: row.counts.applied,
      duplicate: row.counts.duplicate,
      conflict: row.counts.conflict,
      quarantined: row.counts.quarantined,
      differences_opened: row.counts.differencesOpened,
    },
    open_differences: row.openDifferences,
    imported_by: row.importedBy,
    imported_by_name: nameOf(names, row.importedBy),
    created_at: row.createdAt,
    completed_at: row.completedAt,
  };
}

export function rowErrorDto(row: QuarantinedRow): Record<string, unknown> {
  return { line: row.line, business_key: row.businessKey, code: row.errorCode, field: row.field, preview: row.maskedPreview };
}

export function mappingDto(row: EgpMappingRow, names: ReadonlyMap<string, string>, caller: { membershipId: string; mayDecide: boolean; mayRetire: boolean }): Record<string, unknown> {
  return {
    id: row.id,
    subject_type: row.subjectType,
    our_code: row.ourCode,
    project_code: row.projectCode,
    external_type: row.externalType,
    external_code: row.externalCode,
    match_method: row.matchMethod,
    confidence: row.confidence,
    valid_from: row.validFrom,
    valid_until: row.validUntil,
    status: row.status,
    proposed_by: row.proposedBy,
    proposed_by_name: nameOf(names, row.proposedBy),
    proposal_reason: row.proposalReason,
    import_id: row.importId,
    approved_by_name: nameOf(names, row.approvedBy),
    approved_at: row.approvedAt,
    decision_reason: row.decisionReason,
    retired_by_name: nameOf(names, row.retiredBy),
    retired_at: row.retiredAt,
    retire_reason: row.retireReason,
    version: row.version,
    created_at: row.createdAt,
    // The maker does not approve: the screen offers the move only to a person who may make it, and the server judges it again.
    can_decide: caller.mayDecide && row.status === 'PROPOSED' && row.proposedBy !== caller.membershipId,
    can_retire: caller.mayRetire && row.status === 'ACTIVE',
  };
}

export function healthDto(reading: EgpHealthReading): Record<string, unknown> {
  const { view, rule } = reading;
  return {
    status: view.health.status,
    age_hours: view.health.ageHours,
    last_import_at: reading.lastImportAt,
    last_import_kind: reading.lastImportKind,
    alert: view.health.alert === null ? null : { code: view.health.alert.code, severity: view.health.alert.severity },
    figures_blocked: view.health.figuresBlocked,
    apply_blocked: view.applyBlocked,
    rule: {
      source: rule.source,
      version: rule.version,
      unverified: rule.unverified,
      legal_status: rule.legalStatus,
      formula: rule.formula,
      source_text: rule.sourceText,
      as_of: rule.asOf,
      warn_after_hours: rule.params.warnAfterHours,
      max_age_hours: rule.params.maxAgeHours,
      stale_severity: rule.params.staleSeverity,
      figures_blocked_when_stale: rule.params.figuresBlockedWhenStale,
    },
  };
}

export const pendingExternalDto = (): Array<Record<string, unknown>> =>
  EGP_PENDING_EXTERNAL_ITEMS.map((item) => ({ code: item.code, what: item.what, owner: item.owner, working_assumption: item.workingAssumption, switches_when_it_arrives: item.switchesWhenItArrives }));

export const layoutsDto = (positions: Readonly<Record<EgpLayoutKind, string>>): Array<Record<string, unknown>> =>
  EGP_LAYOUT_KINDS.map((kind) => ({
    kind,
    connector_code: positions[kind],
    columns: egpLayoutColumns(kind).map((column) => ({ name: column.name, kind: column.kind, required: column.required, header_required: column.headerRequired, ...(column.values === undefined ? {} : { values: [...column.values] }) })),
  }));

/** The kinds whose required columns a header row has (names compared as the layouts compare them: without case, spaces and hyphens). */
export function kindsFittingHeaders(headers: readonly string[]): EgpLayoutKind[] {
  const present = new Set(headers.map(egpHeaderOf));
  return EGP_LAYOUT_KINDS.filter((kind) => egpLayoutColumns(kind).every((column) => !column.headerRequired || present.has(column.name)));
}

