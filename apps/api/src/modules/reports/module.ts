import { defineModule } from '../module-descriptor';
import { registerMofReportForms, registerPublicReportForms } from './form-registry';
import { LayoutPreviewController } from './layout-preview.controller';
import { PeriodReportController, PeriodReportReadsController } from './period-report.controller';
import { ReportController } from './report.controller';
import { ReportReadsController } from './report-reads.controller';

// The generic forms of the public edition are known to every process; the enterprise forms are added by the enterprise seam of the API when that edition loads.
registerPublicReportForms();
registerMofReportForms();

/**
 * RPT, the report engine (RPT-1): the forms of the edition, the generation of a report for a period into the Excel template (and the Word narrative), the check, approval and issue of the copy by three different people, the
 * insert-only issued copies with their hashes and revisions, and the log of deliveries to the receivers.
 */
export const rptModule = defineModule({
  code: 'RPT',
  controllers: [ReportController, ReportReadsController, LayoutPreviewController, PeriodReportController, PeriodReportReadsController],
});
