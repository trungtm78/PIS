import { defineModule } from '../module-descriptor';
import { PeriodReopenController } from './period-reopen.controller';
import { PeriodSnapshotController } from './period-snapshot.controller';
import { ReportDecisionController } from './report-decision.controller';
import { ReportFileController } from './report-file.controller';
import { ReportImportController } from './report-import.controller';
import { ReportLifecycleController } from './report-lifecycle.controller';
import { ReportSubmitController } from './report-submit.controller';
import { ReportController, ReportReadsController } from './report.controller';
import { ReportingPeriodController, ReportingPeriodReadsController } from './reporting-period.controller';

/** DIS, disbursement reporting: the reporting period calendar with its soft close and lock (ST-DIS-001) and the reasoned reopening of a locked period (ST-DIS-002), and the weekly report draft with its six cells of cumulative disbursement (ST-DIS-003). */
export const disModule = defineModule({
  code: 'DIS',
  controllers: [ReportingPeriodController, ReportingPeriodReadsController, PeriodReopenController, ReportController, ReportReadsController, ReportFileController, ReportSubmitController, ReportDecisionController, ReportLifecycleController, ReportImportController, PeriodSnapshotController],
});
