import { defineModule } from '../module-descriptor';
import { PermitTypeController, PermitTypeReadsController } from './permit-type.controller';

/** PMT, legal files and permits: the permit type catalogue as dated legal data (ST-PMT-001). */
export const pmtModule = defineModule({
  code: 'PMT',
  controllers: [PermitTypeController, PermitTypeReadsController],
});
