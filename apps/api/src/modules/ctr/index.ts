import { defineModule } from '../module-descriptor';
import { ContractController, ContractReadsController, ContractRevisionReadsController } from './contract.controller';

/**
 * CTR, contracts: the register of contracts drafted under an awarded package, with the terms of the draft and the members of a joint
 * venture, read in the scope of the caller and, for a guest contractor, in the scope of its contract (ST-CTR-001).
 */
export const ctrModule = defineModule({
  code: 'CTR',
  controllers: [ContractController, ContractReadsController, ContractRevisionReadsController],
});
