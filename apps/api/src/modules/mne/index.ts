import { defineModule } from '../module-descriptor';
import { MneFormsController } from './mne-forms.controller';
import { MneObligationRulesController } from './mne-obligation-rules.controller';
import { MneObligationsController } from './mne-obligations.controller';
import { MneReportsController } from './mne-reports.controller';

/** MNE, monitoring and evaluation of investment: the report forms and obligation rules as dated data, the filing calendar (ST-MNE-001) and the periodic report filled from a frozen snapshot (ST-MNE-002). */
export const mneModule = defineModule({
  code: 'MNE',
  controllers: [MneFormsController, MneObligationRulesController, MneObligationsController, MneReportsController],
});
