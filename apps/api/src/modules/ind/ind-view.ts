import { isEnterable } from '@machvon/kernel';
import type { EntryViolation, ImportMapping, IndicatorEntry, MappingProblem } from '@machvon/kernel';
import type { EntryRuleView, FigureRow, IndDifferenceRow, IndRunRow, RuleVersionRow } from '@machvon/db';
import type { QuarantinedRow } from '@machvon/db';

/** The name of a person for a screen, or null when the directory does not know the membership. */
const nameOf = (names: ReadonlyMap<string, string>, id: string | null): string | null => (id === null ? null : (names.get(id) ?? null));

export function indicatorDto(entry: IndicatorEntry): Record<string, unknown> {
  return {
    code: entry.code,
    name: entry.name,
    formula: entry.formula,
    numerator: entry.numerator,
    denominator: entry.denominator,
    exclusions: entry.exclusions,
    unit: entry.unit,
    period: entry.period,
    source: entry.source,
    owner: entry.owner,
    decimals: entry.decimals,
    refresh_hours: entry.refreshHours,
    allowed_lag_days: entry.allowedLagDays,
    category: entry.category,
    value_kind: entry.valueKind,
    enterable: isEnterable(entry),
    entry_field: entry.entryField,
    vat_basis: entry.vatBasis,
    aliases: entry.aliases,
    required_on: entry.requiredOn,
    version: entry.version,
    origin: entry.origin,
    unverified: entry.unverified,
    effective_from: entry.effectiveFrom,
    effective_to: entry.effectiveTo,
  };
}

export function versionDto(row: RuleVersionRow, names: ReadonlyMap<string, string>): Record<string, unknown> {
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    effective_from: row.effectiveFrom,
    effective_to: row.effectiveTo,
    reason: row.reason,
    created_by: row.createdBy,
    created_by_name: nameOf(names, row.createdBy),
    created_at: row.createdAt,
    submitted_by_name: nameOf(names, row.submittedBy),
    approved_by: row.approvedBy,
    approved_by_name: nameOf(names, row.approvedBy),
    approved_at: row.approvedAt,
    retired_at: row.retiredAt,
  };
}

/** The people a list of versions names: who made, submitted and approved each. */
export const versionPeople = (rows: readonly RuleVersionRow[]): Array<string | null> => rows.flatMap((row) => [row.createdBy, row.submittedBy, row.approvedBy]);

export function entryRuleDto(view: EntryRuleView): Record<string, unknown> {
  const rule = view.rule;
  return {
    code: rule.code,
    check: rule.check,
    severity: rule.severity,
    fields: [...rule.fields],
    total_field: rule.totalField,
    tolerance: rule.tolerance,
    message: rule.message,
    surfaces: rule.surfaces === null ? null : [...rule.surfaces],
    min: rule.min,
    max: rule.max,
    closed_states: [...rule.closedStates],
    version: rule.version,
    origin: view.origin,
    active: view.active,
    unverified: view.unverified,
    effective_from: view.effectiveFrom,
    effective_to: view.effectiveTo,
  };
}

export const violationDto = (one: EntryViolation): Record<string, unknown> => ({
  rule_code: one.ruleCode,
  rule_version: one.ruleVersion,
  check: one.check,
  severity: one.severity,
  fields: one.fields,
  message: one.message,
  detail: one.detail,
});

export function mappingDto(mapping: ImportMapping, state: { active: boolean; effectiveFrom: string | null; effectiveTo: string | null }, problems: readonly MappingProblem[]): Record<string, unknown> {
  return {
    code: mapping.code,
    name: mapping.name,
    layout: mapping.layout,
    number_format: mapping.numberFormat,
    project_column: mapping.projectColumn,
    period_column: mapping.periodColumn,
    label_column: mapping.labelColumn,
    value_column: mapping.valueColumn,
    lines: mapping.lines.map((line) => ({ indicator: line.indicator, source: line.source, scale: line.scale, required: line.required })),
    version: mapping.version,
    origin: mapping.origin,
    active: state.active,
    unverified: mapping.unverified,
    effective_from: state.effectiveFrom,
    effective_to: state.effectiveTo,
    problems: problems.map((problem) => ({ code: problem.code, indicator: problem.indicator, line: problem.line })),
  };
}

export function figureDto(row: FigureRow, names: ReadonlyMap<string, string>): Record<string, unknown> {
  return {
    id: row.id,
    project_id: row.projectId,
    project_code: row.projectCode,
    period_id: row.periodId,
    period_code: row.periodCode,
    indicator_code: row.indicatorCode,
    revision: row.revision,
    value: row.value,
    unit: row.unit,
    definition_version: row.definitionVersion,
    source: row.source,
    import_id: row.importId,
    import_line: row.importLine,
    mapping_code: row.mappingCode,
    mapping_version: row.mappingVersion,
    reason: row.reason,
    entered_by: row.enteredBy,
    entered_by_name: nameOf(names, row.enteredBy),
    entered_at: row.enteredAt,
  };
}

export function runDto(row: IndRunRow, names: ReadonlyMap<string, string>): Record<string, unknown> {
  return {
    id: row.id,
    format_version: row.formatVersion,
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

export const rowErrorDto = (row: QuarantinedRow): Record<string, unknown> => ({ line: row.line, business_key: row.businessKey, code: row.errorCode, field: row.field, preview: row.maskedPreview });

export function differenceDto(row: IndDifferenceRow, names: ReadonlyMap<string, string>): Record<string, unknown> {
  return { id: row.id, line: row.line, business_key: row.businessKey, code: row.code, expected: row.expected, actual: row.actual, detail: row.detail, status: row.status, owner_name: nameOf(names, row.ownerId), due_at: row.dueAt };
}
