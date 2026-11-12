/**
 * The figures of a weekly or monthly report as the full audit detail keeps them (HT.06): the measurement basis and one entry per funding line, keyed `BUCKET|BUDGET_LEVEL` in a fixed order, so that the value
 * before a save and the value after it have the same shape and the same bytes where nothing moved. Money stays text of whole dong. The words of the narrative and the names of the attachments are not part of it:
 * they are personal data the report keeps in its own tables, and the audit keeps their hash in the sealed diff (`payload_hash`).
 */
export interface FundingFigure {
  bucket: string;
  budgetLevel: string;
  cumulativeVnd: string;
  ctmtqgVnd: string | null;
  nextMonthVnd: string;
  nextMonthCtmtqgVnd: string | null;
  sourceYear: number | null;
}

export interface ReportFiguresDetail {
  measurement_basis: string;
  lines: Record<string, { cumulative_vnd: string; ctmtqg_vnd: string | null; next_month_vnd: string; next_month_ctmtqg_vnd: string | null; source_year: number | null }>;
}

export function reportFiguresDetail(measurementBasis: string, lines: readonly FundingFigure[]): ReportFiguresDetail {
  const ordered = [...lines].sort((left, right) => `${left.bucket}|${left.budgetLevel}`.localeCompare(`${right.bucket}|${right.budgetLevel}`));
  return {
    measurement_basis: measurementBasis,
    lines: Object.fromEntries(
      ordered.map((one) => [
        `${one.bucket}|${one.budgetLevel}`,
        { cumulative_vnd: one.cumulativeVnd, ctmtqg_vnd: one.ctmtqgVnd, next_month_vnd: one.nextMonthVnd, next_month_ctmtqg_vnd: one.nextMonthCtmtqgVnd, source_year: one.sourceYear },
      ]),
    ),
  };
}
