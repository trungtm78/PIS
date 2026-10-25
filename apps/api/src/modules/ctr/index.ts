import { defineModule } from '../module-descriptor';
import { BoqController, BoqLineReadsController } from './boq.controller';
import { ContractController, ContractReadsController, ContractRevisionReadsController } from './contract.controller';
import { ContractLifecycleController } from './lifecycle.controller';
import { ExpiringGuaranteesController, GuaranteeController, GuaranteeReadsController } from './guarantee.controller';

/**
 * CTR, contracts: the register of contracts drafted under an awarded package, with the terms of the draft and the members of a joint
 * venture, read in the scope of the caller and, for a guest contractor, in the scope of its contract (ST-CTR-001); the stable items and the
 * versioned lines of the BOQ of a revision, imported from lines or from a scanned file (ST-CTR-002); the guarantees of a contract, verified by
 * a second person, replaced when extended and released against evidence, with the list of the ones that expire soon (ST-CTR-003); the review, the signing and the activation of a contract,
 * with the conflict of interest, the delegation limit, the guarantee, the permits and the commitment of capital that stand before it (ST-CTR-004).
 */
export const ctrModule = defineModule({
  code: 'CTR',
  controllers: [
    ContractController,
    ContractReadsController,
    ContractRevisionReadsController,
    ContractLifecycleController,
    BoqController,
    BoqLineReadsController,
    GuaranteeController,
    ExpiringGuaranteesController,
    GuaranteeReadsController,
  ],
});
