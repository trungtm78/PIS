import { defineModule } from '../module-descriptor';
import { BoqController, BoqLineReadsController } from './boq.controller';
import { ContractController, ContractReadsController, ContractRevisionReadsController } from './contract.controller';
import { ExpiringGuaranteesController, GuaranteeController, GuaranteeReadsController } from './guarantee.controller';

/**
 * CTR, contracts: the register of contracts drafted under an awarded package, with the terms of the draft and the members of a joint
 * venture, read in the scope of the caller and, for a guest contractor, in the scope of its contract (ST-CTR-001); the stable items and the
 * versioned lines of the BOQ of a revision, imported from lines or from a scanned file (ST-CTR-002); the guarantees of a contract, verified by
 * a second person, replaced when extended and released against evidence, with the list of the ones that expire soon (ST-CTR-003).
 */
export const ctrModule = defineModule({
  code: 'CTR',
  controllers: [
    ContractController,
    ContractReadsController,
    ContractRevisionReadsController,
    BoqController,
    BoqLineReadsController,
    GuaranteeController,
    ExpiringGuaranteesController,
    GuaranteeReadsController,
  ],
});
