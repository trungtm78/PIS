import { defineModule } from '../module-descriptor';
import { ReportingPeriodController, ReportingPeriodReadsController } from './reporting-period.controller';

/** DIS, disbursement reporting: the reporting period calendar with its soft close and lock (ST-DIS-001). */
export const disModule = defineModule({
  code: 'DIS',
  controllers: [ReportingPeriodController, ReportingPeriodReadsController],
});
