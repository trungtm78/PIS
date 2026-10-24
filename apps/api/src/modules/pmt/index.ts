import { defineModule } from '../module-descriptor';
import { PermitDossierController } from './permit-dossier.controller';
import { PermitDossierReadsController, PermitReadsController } from './permit-dossier-reads.controller';
import { PermitTypeController, PermitTypeReadsController } from './permit-type.controller';

/**
 * PMT, legal files and permits: the permit type catalogue as dated legal data (ST-PMT-001) and the project permit dossier with its
 * permits, milestones, decisions and renewals (ST-PMT-002).
 */
export const pmtModule = defineModule({
  code: 'PMT',
  controllers: [PermitTypeController, PermitTypeReadsController, PermitDossierController, PermitDossierReadsController, PermitReadsController],
});
