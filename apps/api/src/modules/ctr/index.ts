import { defineModule } from '../module-descriptor';
import { AcceptanceController, AcceptanceReadsController } from './acceptance.controller';
import { BoqController, BoqLineReadsController } from './boq.controller';
import { ChangeChainController, ChangeRequestReadsController } from './change.controller';
import { ContractController, ContractReadsController, ContractRevisionReadsController } from './contract.controller';
import { ContractLifecycleController } from './lifecycle.controller';
import { MeasurementController, MeasurementReadsController } from './measurement.controller';
import { ExpiringGuaranteesController, GuaranteeController, GuaranteeReadsController } from './guarantee.controller';

/**
 * CTR, contracts: the register of contracts drafted under an awarded package, with the terms of the draft and the members of a joint
 * venture, read in the scope of the caller and, for a guest contractor, in the scope of its contract (ST-CTR-001); the stable items and the
 * versioned lines of the BOQ of a revision, imported from lines or from a scanned file (ST-CTR-002); the guarantees of a contract, verified by
 * a second person, replaced when extended and released against evidence, with the list of the ones that expire soon (ST-CTR-003); the review, the signing and the activation of a contract,
 * with the conflict of interest, the delegation limit, the guarantee, the permits and the commitment of capital that stand before it (ST-CTR-004); the number of tiers of the chain of
 * changes of a project, fixed by its first request, and the change events, the PCOs and the COs raised, promoted, evaluated and withdrawn along it (ST-CTR-006); the decision of a change order and the revisions of the contract it makes (ST-CTR-007); the quantities of work
 * recorded per BOQ item and period, sent, approved and corrected, within the quantity of the revision in force (ST-CTR-008); the acceptance of approved measurements, priced from the revision in force on the day,
 * sent, decided by another person and revoked while no payment request holds it (ST-CTR-009).
 */
export const ctrModule = defineModule({
  code: 'CTR',
  controllers: [
    ContractController,
    ContractReadsController,
    ContractRevisionReadsController,
    ContractLifecycleController,
    ChangeChainController,
    ChangeRequestReadsController,
    MeasurementController,
    MeasurementReadsController,
    AcceptanceController,
    AcceptanceReadsController,
    BoqController,
    BoqLineReadsController,
    GuaranteeController,
    ExpiringGuaranteesController,
    GuaranteeReadsController,
  ],
});
