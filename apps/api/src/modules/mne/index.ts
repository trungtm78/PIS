import { defineModule } from '../module-descriptor';
import { MneFormsController } from './mne-forms.controller';
import { MneObligationRulesController } from './mne-obligation-rules.controller';
import { MneObligationsController } from './mne-obligations.controller';

/** MNE, monitoring and evaluation of investment: the report forms and obligation rules as dated data, and the filing calendar (ST-MNE-001). */
export const mneModule = defineModule({
  code: 'MNE',
  controllers: [MneFormsController, MneObligationRulesController, MneObligationsController],
});
