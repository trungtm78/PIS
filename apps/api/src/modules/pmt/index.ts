import { defineModule } from '../module-descriptor';
import { ExpiringPermitsController } from './expiring-permits.controller';
import { PermitGateController } from './gate.controller';
import { PermitGateWaiverController } from './gate-waiver.controller';
import { PermitDossierController } from './permit-dossier.controller';
import { PermitDossierReadsController, PermitReadsController } from './permit-dossier-reads.controller';
import { PermitTypeController, PermitTypeReadsController } from './permit-type.controller';

/**
 * PMT, legal files and permits: the permit type catalogue as dated legal data (ST-PMT-001) and the project permit dossier with its
 * permits, milestones, decisions and renewals (ST-PMT-002), the board of the permits that run out (ST-PMT-006), the gate rules with the evaluation of the gates (ST-PMT-004), and the time-limited waivers of the gates (ST-PMT-005).
 */
export const pmtModule = defineModule({
  code: 'PMT',
  controllers: [PermitTypeController, PermitTypeReadsController, PermitDossierController, ExpiringPermitsController, PermitGateController, PermitGateWaiverController, PermitDossierReadsController, PermitReadsController],
});
