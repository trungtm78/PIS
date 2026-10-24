import { defineModule } from '../module-descriptor';
import { PeriodReopenController } from './period-reopen.controller';
import { ReportingPeriodController, ReportingPeriodReadsController } from './reporting-period.controller';

/** DIS, disbursement reporting: the reporting period calendar with its soft close and lock (ST-DIS-001) and the reasoned reopening of a locked period (ST-DIS-002). */
export const disModule = defineModule({
  code: 'DIS',
  controllers: [ReportingPeriodController, ReportingPeriodReadsController, PeriodReopenController],
});
