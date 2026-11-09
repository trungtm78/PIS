import { defineModule } from '../module-descriptor';
import { CrossTotalController } from './cross-total.controller';
import { DisbursementForecastController } from './disbursement-forecast.controller';
import { DisbursementRatesController } from './disbursement-rates.controller';
import { EarlyWarningController } from './early-warning.controller';
import { MilestoneForecastController } from './milestone-forecast.controller';
import { ReportNarrativeController } from './narrative.controller';
import { PeriodReopenController } from './period-reopen.controller';
import { PeriodSnapshotController } from './period-snapshot.controller';
import { DisReportApprovalBinding } from './report-approval.binding';
import { ReportDecisionController } from './report-decision.controller';
import { ReportFileController } from './report-file.controller';
import { ReportExportController } from './report-export.controller';
import { ReportImportController } from './report-import.controller';
import { ReportLifecycleController } from './report-lifecycle.controller';
import { ReportSubmitController } from './report-submit.controller';
import { ReportWorkflowReadsController } from './report-workflow.controller';
import { ReportController, ReportReadsController } from './report.controller';
import { ReportingPeriodController, ReportingPeriodReadsController } from './reporting-period.controller';
import { ReportingCalendarController } from './reporting-calendar.controller';
import { SubmissionProgressController } from './submission-progress.controller';
import { WeeklyPlanController } from './weekly-plan.controller';

/** DIS, disbursement reporting: the reporting period calendar with its soft close and lock (ST-DIS-001) and the reasoned reopening of a locked period (ST-DIS-002), and the weekly report draft with its six cells of cumulative disbursement (ST-DIS-003). */
export const disModule = defineModule({
  code: 'DIS',
  providers: [DisReportApprovalBinding],
  // The read of the approval steps comes first: tests of this module count its controllers from the end of the list.
  controllers: [ReportWorkflowReadsController, MilestoneForecastController, ReportingPeriodController, ReportingPeriodReadsController, PeriodReopenController, ReportController, ReportReadsController, ReportFileController, ReportSubmitController, ReportDecisionController, ReportLifecycleController, ReportImportController, PeriodSnapshotController, DisbursementRatesController, EarlyWarningController, WeeklyPlanController, SubmissionProgressController, ReportingCalendarController, ReportExportController, DisbursementForecastController, CrossTotalController, ReportNarrativeController],
});
