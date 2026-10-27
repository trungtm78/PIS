import type { DisPeriodStore, DisReportStore, RevisionDetail, TenantTx } from '@machvon/db';
import { reviewReport, treasuryWindow } from '@machvon/kernel';
import type { Review } from '@machvon/kernel';

/**
 * The review of a draft (BR-DIS-07), the one DIS-06 shows and the one a send is judged by: the same errors the server would answer, and the warnings, all at once. The period is judged as a send
 * would judge it (a locked period with no approved reopening covering the project is an error), the plan version against the one in force at the end of the period, and the cumulative against what
 * the Treasury paid in the window of the basis.
 */
export async function reviewOf(tx: TenantTx, reports: DisReportStore, periods: DisPeriodStore, detail: RevisionDetail, at: Date): Promise<Review> {
  const periodClosed = await periods.closedFor(tx, detail.period.id, detail.project.id, at);
  const effective = await reports.effectivePlan(tx, detail.project.id, detail.period.fiscalYear, detail.period.endDate);
  const treasury = await reports.treasuryFigure(tx, detail.project.id, treasuryWindow(detail.measurementBasis, detail.period));
  return reviewReport({
    status: detail.status,
    deleted: detail.deleted,
    reportType: detail.reportType,
    narrativeCausesText: detail.narrative?.causesText ?? null,
    periodClosed,
    planInForce: effective?.id === detail.plan.id,
    cells: detail.lines.map((row) => ({
      cumulativeVnd: row.cumulativeVnd,
      ctmtqgVnd: row.ctmtqgVnd,
      nextMonthVnd: row.nextMonthVnd,
      nextMonthCtmtqgVnd: row.nextMonthCtmtqgVnd,
      allocatedVnd: row.allocatedVnd,
      deltaVnd: row.deltaVnd,
    })),
    negativeDeltaExplanation: detail.negativeDeltaExplanation,
    progress: detail.progress,
    treasuryVnd: treasury?.totalVnd ?? null,
  });
}
