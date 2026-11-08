import { PERMISSIONS } from '@machvon/contracts';
import type { FigureBatch, FigureRow, ResolvedPack } from '@machvon/db';
import { effectivePermissions, fundingPeriodRange, holdsPermission } from '@machvon/kernel';
import type { CellFigures, EffectiveAccess, FigureHistoryEntry, FigurePeriodRef, FundingIndicator, MoneyIndicator } from '@machvon/kernel';

/** What the caller may do with figures, from the permissions it holds in any grant (the server judges each command again, with the scope of the project). */
export function figureActions(access: EffectiveAccess, now: Date): { prepare: boolean; accept: boolean } {
  const held = effectivePermissions(access, now);
  return { prepare: holdsPermission(held, PERMISSIONS.proposeFundingFigures), accept: holdsPermission(held, PERMISSIONS.acceptFundingFigures) };
}

/** The pack in force as a screen reads it: classes, tiers, measures, the ratios the pack publishes (each with its formula code), and where the numbers come from. */
export function taxonomyDto(resolved: ResolvedPack, provenance: { formula: string; source: string; asOf: string; legalStatus: string } | null, asOf: string, actions: { prepare: boolean; accept: boolean }): Record<string, unknown> {
  const { pack } = resolved;
  return {
    pack_code: pack.packCode,
    pack_label: pack.label,
    version: resolved.version,
    rule_id: resolved.ruleId,
    unverified: resolved.unverified,
    entry_mode: pack.entryMode,
    phasing_must_sum: pack.phasingMustSum,
    actuals_precedence: pack.actualsPrecedence,
    variance_tolerance: { pct: pack.varianceTolerance.pct, abs_vnd: String(pack.varianceTolerance.absVnd) },
    measures: [...pack.measures],
    period_grains: [...pack.periodGrains],
    classes: pack.classes.map((one) => ({ code: one.code, label: one.label, additive: one.additive, source: pack.actualsSource.get(one.code) ?? null })),
    tiers: pack.tiers.map((one) => ({ code: one.code, label: one.label })),
    subsets: pack.subsets.map((one) => ({ code: one.code, label: one.label, of_classes: [...one.ofClasses] })),
    tags: pack.tags.map((one) => ({ code: one.code, label: one.label, carries_amount: one.carriesAmount })),
    ratios: pack.ratios.map((one) => ({ code: one.code, numerator: one.numerator, denominator: one.denominator, basis: one.basis, class_filter: [...one.classFilter], formula_code: one.code })),
    provenance: provenance === null ? { formula: null, source: null, as_of: null, legal_status: null } : { formula: provenance.formula, source: provenance.source, as_of: provenance.asOf, legal_status: provenance.legalStatus },
    actions: { prepare: actions.prepare, accept: actions.accept },
    as_of: asOf,
  };
}

export const periodDto = (period: FigurePeriodRef): Record<string, unknown> => {
  const range = fundingPeriodRange(period);
  return { grain: period.grain, plan_year: period.planYear, ordinal: period.ordinal, start: range.start, end: range.end };
};

export function cellDto(cell: CellFigures): Record<string, unknown> {
  return {
    class_code: cell.classCode,
    tier_code: cell.tierCode,
    measure: cell.measure,
    plan_year_vnd: cell.planYear,
    plan_adjusted_vnd: cell.planAdjusted,
    plan_in_force_vnd: cell.planInForce,
    plan_period_vnd: cell.planPeriod,
    plan_to_date_vnd: cell.planToDate,
    estimate_vnd: cell.estimate,
    estimate_as_reported_vnd: cell.estimateAsReported,
    actual_vnd: cell.actual,
    cumulative_ytd_vnd: cell.cumulativeYtd,
    cumulative_since_start_vnd: cell.cumulativeSinceStart,
    estimate_year_vnd: cell.estimateYear,
    estimate_year_reason: cell.estimateYearReason,
    gap_months: cell.gapMonths,
    actual_bases: cell.actualBases,
    actual_flash: cell.actualFlash,
    source_ids: cell.sourceIds,
  };
}

export const rateDto = (one: FundingIndicator): Record<string, unknown> => ({
  code: one.code,
  class_code: one.classCode,
  measure: one.measure,
  numerator_term: one.numeratorTerm,
  denominator_term: one.denominatorTerm,
  basis: one.basis,
  numerator_vnd: one.numeratorVnd,
  denominator_vnd: one.denominatorVnd,
  rate_pct: one.ratePct,
  null_reason: one.nullReason,
  projects: one.projects,
  formula_code: one.code,
  as_of: one.asOf,
  pack_code: one.packCode,
});

export const moneyDto = (one: MoneyIndicator): Record<string, unknown> => ({ code: one.code, class_code: one.classCode, measure: one.measure, value_vnd: one.valueVnd, additive: one.additive, formula_code: one.code, as_of: one.asOf, pack_code: one.packCode });

export function entryDto(row: FigureRow): Record<string, unknown> {
  return {
    id: row.id,
    period_ordinal: row.ordinal,
    amount_vnd: row.amountVnd,
    revision: row.revision,
    status: row.status,
    supersedes_id: row.supersedesId,
    converted_from_id: row.convertedFromId ?? null,
    estimate_amount_vnd: row.estimateAmountVnd ?? null,
    conversion_reason: row.conversionReason ?? null,
    flash: row.flash ?? false,
    adjusts: row.adjusts === null || row.adjusts === undefined ? null : { plan_year: row.adjusts.planYear, period_ordinal: row.adjusts.ordinal },
  };
}

/** A batch with its figures and what the caller may do with it: the preparer submits and withdraws, somebody else accepts or returns (maker is not checker). */
export function batchDto(batch: FigureBatch, member: string, can: { prepare: boolean; accept: boolean }): Record<string, unknown> {
  const mine = batch.preparedBy === member;
  return {
    batch_id: batch.batchId,
    project_id: batch.projectId,
    project_code: batch.projectCode,
    taxonomy_pack: batch.taxonomyPack,
    class_code: batch.classCode,
    tier_code: batch.tierCode,
    measure: batch.measure,
    figure_kind: batch.kind,
    period_grain: batch.grain,
    plan_year: batch.planYear,
    basis: batch.basis,
    status: batch.status,
    as_of_date: batch.asOfDate,
    explanation: batch.explanation,
    decision_document_id: batch.decisionDocumentId,
    prepared_by_me: mine,
    approved_at: batch.approvedAt,
    created_at: batch.createdAt,
    version: batch.version,
    entries: batch.entries.map(entryDto),
    actions: {
      submit: batch.status === 'DRAFT' && mine && can.prepare,
      withdraw: (batch.status === 'DRAFT' || batch.status === 'SUBMITTED') && mine && can.prepare,
      accept: batch.status === 'SUBMITTED' && !mine && can.accept,
      return: batch.status === 'SUBMITTED' && !mine && can.accept,
    },
  };
}

export const historyEntryDto = (entry: FigureHistoryEntry): Record<string, unknown> => ({
  id: entry.id,
  figure_kind: entry.kind,
  basis: entry.basis,
  revision: entry.revision,
  as_of_date: entry.asOfDate,
  status: entry.status,
  amount_vnd: entry.amountVnd,
  change_vnd: entry.changeVnd,
  converted_from_id: entry.convertedFromId,
  estimate_amount_vnd: entry.estimateAmountVnd,
  conversion_reason: entry.conversionReason,
  conversion_delta_vnd: entry.conversionDeltaVnd,
});

export const pendingDto = (row: FigureRow): Record<string, unknown> => ({ batch_id: row.batchId, figure_kind: row.kind, period_ordinal: row.ordinal, amount_vnd: row.amountVnd, status: row.status, as_of_date: row.asOfDate });
